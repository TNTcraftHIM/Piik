//! JNI objects stay attached to their owning capture; no native callback pointers.
use anyhow::{bail, Context, Result};
use jni::{
    jni_sig, jni_str,
    objects::{IntoAuto, JObject, JObjectArray, JString},
    refs::{Cast, Global},
    Env, JavaVM,
};
use std::sync::Arc;

pub(super) fn supports_cbr(name: &str, mime: &str) -> Result<bool> {
    let context = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) };
    vm.attach_current_thread(|env| -> Result<bool> {
        let list = env.new_object(
            jni_str!("android/media/MediaCodecList"),
            jni_sig!((int) -> void),
            &[1.into()], // ALL_CODECS
        )?;
        let infos = env
            .call_method(
                &list,
                jni_str!("getCodecInfos"),
                jni_sig!(() -> android.media.MediaCodecInfo[]),
                &[],
            )?
            .l()?;
        let infos = JObjectArray::<JObject>::cast_local(env, infos)?;
        for index in 0..infos.len(env)? {
            let info = infos.get_element(env, index)?.auto();
            let codec_name = env
                .call_method(
                    &info,
                    jni_str!("getName"),
                    jni_sig!(() -> java.lang.String),
                    &[],
                )?
                .l()?;
            let codec_name = JString::cast_local(env, codec_name)?.auto();
            if codec_name.mutf8_chars(env)?.to_string() != name {
                continue;
            }
            let mime = JString::from_str(env, mime)?;
            let caps = env
                .call_method(
                    &info,
                    jni_str!("getCapabilitiesForType"),
                    jni_sig!((java.lang.String) -> android.media.MediaCodecInfo::CodecCapabilities),
                    &[(&mime).into()],
                )?
                .l()?;
            let encoder = env
                .call_method(
                    &caps,
                    jni_str!("getEncoderCapabilities"),
                    jni_sig!(() -> android.media.MediaCodecInfo::EncoderCapabilities),
                    &[],
                )?
                .l()?;
            return Ok(env
                .call_method(
                    &encoder,
                    jni_str!("isBitrateModeSupported"),
                    jni_sig!((int) -> boolean),
                    &[2.into()], // BITRATE_MODE_CBR
                )?
                .z()?);
        }
        bail!("selected encoder is absent from MediaCodecList")
    })
    .with_context(|| format!("query Android CBR support for {name} ({mime})"))
}

pub(super) fn activation_url() -> Result<String> {
    let context = ndk_context::android_context();
    let vm = unsafe { JavaVM::from_raw(context.vm().cast()) };
    vm.attach_current_thread(|env| {
        let raw = context.context().cast();
        let app = unsafe { Cast::<JObject>::from_raw(env, &raw) }?;
        let package = env
            .call_method(
                &app,
                jni_str!("getPackageName"),
                jni_sig!(() -> java.lang.String),
                &[],
            )?
            .l()?;
        let package = JString::cast_local(env, package)?
            .mutf8_chars(env)?
            .to_string();
        Ok(format!(
            "intent://media#Intent;scheme=piik;package={package};end"
        ))
    })
}

#[derive(Clone)]
pub(super) struct Platform {
    pub object: Arc<Global<JObject<'static>>>,
    vm: Arc<JavaVM>,
}
impl Platform {
    pub fn new(audio: bool) -> Result<Self> {
        Self::create(audio, None)
    }
    pub fn microphone(device_id: String) -> Result<Self> {
        Self::create(false, Some(device_id))
    }
    fn create(audio: bool, microphone: Option<String>) -> Result<Self> {
        let context = ndk_context::android_context();
        // Application global reference and VM are installed before app::serve starts.
        let vm = Arc::new(unsafe { JavaVM::from_raw(context.vm().cast()) });
        let object = vm.attach_current_thread(|env| -> Result<_> {
            let raw = context.context().cast();
            let app = unsafe { Cast::<JObject>::from_raw(env, &raw) }?;
            let loader = env
                .call_method(
                    &app,
                    jni_str!("getClassLoader"),
                    jni_sig!(() -> java.lang.ClassLoader),
                    &[],
                )?
                .l()?;
            let name = JString::from_str(
                env,
                if microphone.is_some() {
                    "tv.piik.android.MicrophonePlatform"
                } else {
                    "tv.piik.android.CapturePlatform"
                },
            )?;
            let class = env
                .call_method(
                    &loader,
                    jni_str!("loadClass"),
                    jni_sig!((java.lang.String) -> java.lang.Class),
                    &[(&name).into()],
                )?
                .l()?;
            let class = jni::objects::JClass::cast_local(env, class)?;
            let instance = if let Some(device_id) = microphone {
                let device = JString::from_str(env, device_id)?;
                env.new_object(
                    class,
                    jni_sig!((android.content.Context, java.lang.String) -> void),
                    &[(&*app).into(), (&device).into()],
                )?
            } else {
                env.new_object(
                    class,
                    jni_sig!((android.content.Context, boolean) -> void),
                    &[(&*app).into(), audio.into()],
                )?
            };
            Ok(env.new_global_ref(instance)?)
        })?;
        Ok(Self {
            object: Arc::new(object),
            vm,
        })
    }
    pub fn with<T>(
        &self,
        f: impl FnOnce(&mut Env, &Global<JObject<'static>>) -> Result<T>,
    ) -> Result<T> {
        self.vm.attach_current_thread(|env| f(env, &self.object))
    }
    pub fn stop(&self) {
        if let Err(error) = self.with(|env, object| {
            env.call_method(object, jni_str!("close"), jni_sig!(() -> void), &[])?;
            Ok(())
        }) {
            eprintln!("Android projection close: {error:#}");
        }
    }
}
