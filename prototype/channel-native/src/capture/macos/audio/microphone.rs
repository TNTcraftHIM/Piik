//! AVAudioEngine owns the selected input and AVAudioConverter owns resampling.
use super::{checked, AudioControl, AudioFrame, Clock, Pcm};
use crate::capture::MicrophoneDevice;
use anyhow::{anyhow, ensure, Context as _, Result};
use cidre::{arc, at, av, cf, cm, core_audio, define_obj_type, ns, objc};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub fn microphones() -> Result<Vec<MicrophoneDevice>> {
    checked(core_audio::System::devices())?
        .into_iter()
        .filter_map(|device| {
            let inputs = device.input_stream_cfg().ok()?;
            if !inputs
                .buffers()
                .iter()
                .any(|input| input.number_channels > 0)
            {
                return None;
            }
            Some((|| {
                Ok(MicrophoneDevice {
                    id: checked(device.uid())?.to_string(),
                    label: checked(device.name())?.to_string(),
                })
            })())
        })
        .collect()
}

// cidre exposes AUAudioUnit but not this public macOS input-device setter.
define_obj_type!(InputUnit(at::au::AudioUnit));
impl InputUnit {
    #[objc::msg_send(setDeviceID:error:)]
    unsafe fn set_device<'a>(&mut self, id: u32, error: *mut Option<&'a ns::Error>) -> bool;
}
unsafe extern "C" {
    static AVAudioEngineConfigurationChangeNotification: &'static ns::NotificationName;
}

pub(super) async fn run(
    device_id: String,
    control: &AudioControl,
    frames: mpsc::Sender<AudioFrame>,
    ready: &mut Option<oneshot::Sender<Result<()>>>,
) -> Result<()> {
    let permitted = tokio::select! {
        _ = control.stopped() => return Ok(()),
        permitted = av::CaptureDevice::request_access_for_media_type(av::MediaType::audio()) => checked(permitted)?,
    };
    ensure!(permitted, "microphone_authorization_cancelled");
    let device = if device_id.is_empty() {
        checked(core_audio::System::default_input_device())?
    } else {
        checked(core_audio::Device::with_uid(&cf::String::from_str(
            &device_id,
        )))?
    };
    ensure!(!device.is_unknown(), "selected microphone unavailable");
    let mut engine = av::AudioEngine::new();
    let mut input = engine.input_node();
    let mut unit = input.audio_unit();
    // InputUnit adds only a selector to this same retained AUAudioUnit object.
    let unit = unsafe { &mut *(unit.as_mut() as *mut at::au::AudioUnit as *mut InputUnit) };
    checked(ns::if_false(|error| unsafe {
        unit.set_device(device.0 .0, error)
    }))?;
    let format = input.output_format_for_bus(0);
    ensure!(
        format.sample_rate() > 0.0 && format.channel_count() > 0,
        "microphone has no input format"
    );
    let output = av::AudioFormat::standard_with_sample_rate_and_channels(48_000.0, 2)
        .context("microphone output format")?;
    let converter =
        av::AudioConverter::with_formats(&format, &output).context("microphone converter")?;
    let mut converted = Converted {
        converter,
        input: format.clone(),
        output,
        pcm: Pcm::default(),
        clock: Clock::new(),
        next_sample: None,
        expected_sample: None,
        frames,
    };
    let callback = control.clone();
    checked(
        input.install_tap_on_bus(0, 960, Some(&format), move |buffer, time| {
            if callback.is_stopped() {
                return;
            }
            if let Err(error) = converted.receive(buffer, time) {
                callback.0.finish(Some(format!("{error:#}")));
            }
        }),
    )?;
    let mut notifications = ns::NotificationCenter::default();
    let changed = control.clone();
    let observer = notifications.add_observer_guard(
        unsafe { AVAudioEngineConfigurationChangeNotification },
        Some(engine.as_ref()),
        None,
        move |_| {
            changed
                .0
                .finish(Some("microphone hardware configuration changed".into()))
        },
    );
    let result = async {
        if control.is_stopped() {
            return Ok(());
        }
        checked(engine.start())?;
        if let Some(ready) = ready.take() {
            let _ = ready.send(Ok(()));
        }
        control.stopped().await;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    // The notification only signals this owner; never tear down inside Apple's callback.
    drop(observer);
    engine.stop();
    let removed = checked(input.remove_tap_on_bus(0));
    result?;
    if let Some(error) = &control.0.state.lock().unwrap().error {
        return Err(anyhow!(error.clone()));
    }
    removed
}

struct Converted {
    converter: arc::R<av::AudioConverter>,
    input: arc::R<av::AudioFormat>,
    output: arc::R<av::AudioFormat>,
    pcm: Pcm,
    clock: Clock,
    next_sample: Option<f64>,
    expected_sample: Option<i64>,
    frames: mpsc::Sender<AudioFrame>,
}
impl Converted {
    fn receive(&mut self, buffer: &av::AudioPcmBuf, time: &av::AudioTime) -> Result<()> {
        ensure!(
            time.is_host_time_valid() && time.is_sample_time_valid(),
            "microphone capture timestamp missing"
        );
        if self
            .expected_sample
            .is_some_and(|next| next != time.sample_time())
        {
            self.converter = av::AudioConverter::with_formats(&self.input, &self.output)
                .context("microphone converter")?;
            self.pcm = Pcm::default();
            self.next_sample = None;
        }
        self.expected_sample = Some(time.sample_time() + i64::from(buffer.frame_len()));
        let captured = self
            .clock
            .project(cm::Clock::make_host_time_from_sys_units(time.host_time()))?;
        self.next_sample.get_or_insert(time.sample_time() as f64);
        let capacity =
            (f64::from(buffer.frame_len()) * 48_000.0 / self.input.sample_rate()).ceil() as u32 + 1;
        let mut output = av::AudioPcmBuf::with_format(&self.output, capacity)
            .context("microphone PCM buffer")?;
        let retained = buffer.retained();
        let mut supplied = false;
        let mut input = av::AudioConverterInputBlock::new2(
            move |_, status: &mut av::AudioConverterInputStatus| {
                if supplied {
                    *status = av::AudioConverterInputStatus::NoDataNow;
                    return None;
                }
                supplied = true;
                *status = av::AudioConverterInputStatus::HaveData;
                // The converter consumes this retained native buffer synchronously.
                unsafe { arc::return_opt_rar::<av::AudioBuf>(Some(&retained)) }
            },
        );
        loop {
            let status = checked(
                self.converter
                    .convert_to_buf_with_input_from_block(&mut output, &mut input),
            )?;
            let left = output
                .data_f32_at(0)
                .context("microphone Float32 left channel")?;
            let right = output
                .data_f32_at(1)
                .context("microphone Float32 right channel")?;
            // Project the converter's next sample through this capture buffer's
            // hardware sample/host-time pair, including buffered resampler input.
            let delta =
                (self.next_sample.unwrap() - time.sample_time() as f64) / self.input.sample_rate();
            let offset = Duration::from_secs_f64(delta.abs());
            let start = if delta < 0.0 {
                captured - offset
            } else {
                captured + offset
            };
            for (index, (left, right)) in left.iter().zip(right).enumerate() {
                let time = start + Duration::from_nanos(index as u64 * 1_000_000_000 / 48_000);
                if let Some(frame) = self.pcm.push([*left, *right], time) {
                    match self.frames.try_send(frame) {
                        Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                        Err(mpsc::error::TrySendError::Closed(_)) => {
                            return Err(anyhow!("audio consumer closed"))
                        }
                    }
                }
            }
            self.next_sample = Some(
                self.next_sample.unwrap()
                    + f64::from(output.frame_len()) * self.input.sample_rate() / 48_000.0,
            );
            if status != av::audio::ConverterOutputStatus::HaveData {
                break;
            }
        }
        Ok(())
    }
}
