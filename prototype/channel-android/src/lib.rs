//! The Java Service owns this runtime; all room and site state stays in app::serve.
use anyhow::{anyhow, Context, Result};
use jni::{
    errors::ThrowRuntimeExAndDefault,
    jni_mangle, jni_sig, jni_str,
    objects::{JClass, JObject, JString},
    refs::Global,
    sys::jlong,
    Env, EnvUnowned,
};
use piik_channel_prototype::app::{self, Config};
use std::{path::PathBuf, sync::OnceLock, thread::JoinHandle};
use tokio::sync::oneshot;

#[cfg(target_os = "android")]
mod stderr;

// Application Context, unlike Activity or Service, lives for the process lifetime.
static CONTEXT: OnceLock<Global<JObject<'static>>> = OnceLock::new();

struct Runtime {
    entry: String,
    stop: oneshot::Sender<()>,
    thread: JoinHandle<Result<()>>,
}

fn java_result<T>(env: &mut Env, result: Result<T>) -> jni::errors::Result<T> {
    result.map_err(|error| {
        let message = jni::strings::JNIString::from(format!("{error:#}"));
        let _ = env.throw_new(jni_str!("java/lang/RuntimeException"), message);
        jni::errors::Error::JavaException
    })
}

#[jni_mangle("tv.piik.android.NativeRuntime")]
pub fn nativeStart<'local>(
    mut unowned: EnvUnowned<'local>,
    owner: JObject<'local>,
    context: JObject<'local>,
    data: JString<'local>,
    cache: JString<'local>,
    assets: JString<'local>,
    helper: JString<'local>,
) -> jlong {
    #[cfg(target_os = "android")]
    stderr::init();
    unowned
        .with_env(|env| {
            let result = (|| -> Result<jlong> {
                let vm = env.get_java_vm()?;
                let application = env.new_global_ref(&context)?;
                let cache = cache.mutf8_chars(env)?.to_string();
                rustls_platform_verifier::android::init_with_env(env, context)?;
                CONTEXT.get_or_init(|| {
                    std::env::set_var("TMPDIR", cache);
                    // No runtime/network thread exists before this initialization.
                    unsafe {
                        ndk_context::initialize_android_context(
                            vm.get_raw().cast(),
                            application.as_raw().cast(),
                        );
                    }
                    application
                });
                let config = Config {
                    data_root: PathBuf::from(data.mutf8_chars(env)?.to_string()),
                    assets: PathBuf::from(assets.mutf8_chars(env)?.to_string()),
                    cloudflared: PathBuf::from(helper.mutf8_chars(env)?.to_string()),
                    open_browser: false,
                    ice_servers: piik_channel_prototype::ice_servers_from_environment()?,
                };
                anyhow::ensure!(
                    config.assets.join("index.html").is_file(),
                    "App frontend is missing"
                );
                let callback = env.new_global_ref(owner)?;
                let (ready, started) = oneshot::channel();
                let (stop, stopped) = oneshot::channel();
                let thread =
                    std::thread::Builder::new()
                        .name("piik-app".into())
                        .spawn(move || {
                            let result: Result<()> = (|| {
                                tokio::runtime::Builder::new_multi_thread()
                                    .worker_threads(2)
                                    .enable_all()
                                    .build()?
                                    .block_on(async {
                                        let listener = app::listen(None).await?;
                                        app::serve(
                                            listener,
                                            config,
                                            async {
                                                let _ = stopped.await;
                                            },
                                            Some(ready),
                                        )
                                        .await
                                    })
                            })();
                            let reason = result
                                .as_ref()
                                .err()
                                .map(|error| format!("{error:#}"))
                                .unwrap_or_default();
                            let notification: jni::errors::Result<()> =
                                vm.attach_current_thread(|env| {
                                    let message = JString::from_str(env, reason)?;
                                    env.call_method(
                                        &callback,
                                        jni_str!("runtimeStopped"),
                                        jni_sig!((JString) -> void),
                                        &[(&message).into()],
                                    )?;
                                    Ok(())
                                });
                            if let Err(error) = notification {
                                eprintln!("Runtime exit notification failed: {error}");
                            }
                            result
                        })?;
                let entry = match started.blocking_recv() {
                    Ok(entry) => entry,
                    Err(_) => {
                        thread
                            .join()
                            .map_err(|_| anyhow!("App runtime panicked during startup"))??;
                        return Err(anyhow!("App stopped before becoming ready"));
                    }
                };
                Ok(Box::into_raw(Box::new(Runtime {
                    entry,
                    stop,
                    thread,
                })) as jlong)
            })();
            java_result(env, result)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[jni_mangle("tv.piik.android.NativeRuntime")]
pub fn nativeEntryURL<'local>(
    mut unowned: EnvUnowned<'local>,
    _: JClass<'local>,
    handle: jlong,
) -> JString<'local> {
    unowned
        .with_env(|env| {
            // The private Java facade reads this before close and never exposes the handle.
            let runtime = unsafe { &*(handle as *const Runtime) };
            JString::from_str(env, &runtime.entry)
        })
        .resolve::<ThrowRuntimeExAndDefault>()
}

#[jni_mangle("tv.piik.android.NativeRuntime")]
pub fn nativeStop<'local>(mut unowned: EnvUnowned<'local>, _: JClass<'local>, handle: jlong) {
    unowned
        .with_env(|env| {
            let runtime = unsafe { Box::from_raw(handle as *mut Runtime) };
            let _ = runtime.stop.send(());
            let result = runtime
                .thread
                .join()
                .map_err(|_| anyhow!("App runtime panicked"))
                .and_then(|result| result)
                .context("Stop App runtime");
            java_result(env, result)
        })
        .resolve::<ThrowRuntimeExAndDefault>();
}
