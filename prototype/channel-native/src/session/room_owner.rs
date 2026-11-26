use super::*;
use std::sync::LazyLock;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

pub(super) type Writes = Vec<(Command, Option<String>)>;
pub(super) struct Delivery {
    pub current: bool,
    pub connected: bool,
}
pub(super) type Finish = Box<dyn FnOnce(&mut Session, Delivery) -> Result<Writes> + Send>;
type Execute = Box<dyn FnOnce(&mut Option<HostedRoom>) -> Result<Finish> + Send>;
pub(super) type Admission = Option<Arc<OwnedSemaphorePermit>>;

pub(super) struct Slot {
    send: mpsc::UnboundedSender<Request>,
    pub identity: Arc<AtomicBool>,
    creator: Uuid,
    binding: watch::Receiver<Option<Uuid>>,
    pub source: Option<PathBuf>,
    pub installing: bool,
    released: watch::Receiver<bool>,
}
impl Slot {
    pub fn binding(&self) -> Option<Uuid> {
        *self.binding.borrow()
    }
    pub fn creator_id(&self) -> Uuid {
        self.creator
    }
}
// All network and administrative work holds its byte or local request permit through delivery.
// The unbounded mailbox only transports work already admitted by those owners.
struct Request {
    execute: Execute,
    accepted: Admission,
    carrier: Arc<AtomicBool>,
    local: bool,
    survive_retirement: bool,
}
pub(super) struct Completion {
    pub id: String,
    pub identity: Arc<AtomicBool>,
    pub carrier: Arc<AtomicBool>,
    pub result: Result<Finish>,
    _accepted: Admission,
    _delivered: oneshot::Sender<()>,
    _capacity: OwnedSemaphorePermit,
}

pub(super) struct Rooms {
    slots: BTreeMap<String, Slot>,
    retiring: BTreeMap<String, watch::Receiver<bool>>,
    output: Option<mpsc::UnboundedSender<Completion>>,
    pub finished: mpsc::UnboundedReceiver<Completion>,
    tasks: JoinSet<String>,
    delivery: Arc<Semaphore>,
    execution: Arc<Semaphore>,
    pub carrier: Arc<AtomicBool>,
    #[cfg(test)]
    pub pending: usize,
    pub admission: Admission,
}
impl std::ops::Deref for Rooms {
    type Target = BTreeMap<String, Slot>;
    fn deref(&self) -> &Self::Target {
        &self.slots
    }
}
impl From<BTreeMap<String, HostedRoom>> for Rooms {
    fn from(hosts: BTreeMap<String, HostedRoom>) -> Self {
        static EXECUTION: LazyLock<(Arc<Semaphore>, usize)> = LazyLock::new(|| {
            let n = std::thread::available_parallelism().map_or(2, |n| n.get().max(2));
            (Arc::new(Semaphore::new(n)), n)
        });
        Self::with_execution(hosts, EXECUTION.0.clone(), EXECUTION.1)
    }
}
impl Rooms {
    pub(super) fn with_execution(
        hosts: BTreeMap<String, HostedRoom>,
        execution: Arc<Semaphore>,
        delivery_width: usize,
    ) -> Self {
        let (output, finished) = mpsc::unbounded_channel();
        let mut rooms = Self {
            slots: BTreeMap::new(),
            retiring: BTreeMap::new(),
            output: Some(output),
            finished,
            tasks: JoinSet::new(),
            delivery: Arc::new(Semaphore::new(delivery_width)),
            execution,
            carrier: Arc::new(AtomicBool::new(true)),
            #[cfg(test)]
            pending: 0,
            admission: None,
        };
        for (id, host) in hosts {
            rooms.insert(id, host);
        }
        rooms
    }
}
impl Rooms {
    pub fn insert(&mut self, id: String, host: HostedRoom) {
        let (path, _, creator) = host.snapshot_source();
        self.start(id, creator, Some(path), Some(host));
    }
    pub fn reserve(&mut self, id: &str, creator: Uuid) {
        if !self.slots.contains_key(id) {
            self.start(id.to_string(), creator, None, None)
        }
    }
    fn start(
        &mut self,
        id: String,
        creator: Uuid,
        source: Option<PathBuf>,
        mut host: Option<HostedRoom>,
    ) {
        let (send, mut inbox) = mpsc::unbounded_channel::<Request>();
        let (binding, bound) = watch::channel(None);
        if let Some(host) = host.as_mut() {
            host.publish_binding(binding.clone());
        }
        let (released, done) = watch::channel(false);
        let prior = self.retiring.remove(&id);
        let identity = Arc::new(AtomicBool::new(true));
        self.slots.insert(
            id.clone(),
            Slot {
                send,
                identity: identity.clone(),
                creator,
                binding: bound,
                source,
                installing: false,
                released: done,
            },
        );
        let output = self.output.as_ref().expect("live room registry").clone();
        let execution = self.execution.clone();
        let delivery = self.delivery.clone();
        self.tasks.spawn(async move {
            if let Some(mut prior) = prior {
                let _ = prior.wait_for(|released| *released).await;
            }
            while let Some(request) = inbox.recv().await {
                let capacity = delivery
                    .clone()
                    .acquire_owned()
                    .await
                    .expect("live room capacity");
                let permit = execution
                    .clone()
                    .acquire_owned()
                    .await
                    .expect("native execution capacity");
                let active = identity.clone();
                let carrier = request.carrier.clone();
                let binding = binding.clone();
                let joined = tokio::task::spawn_blocking(move || {
                    let _permit = permit;
                    let result = if (active.load(Ordering::Acquire) || request.survive_retirement)
                        && (request.local || carrier.load(Ordering::Acquire))
                    {
                        let first = host.is_none();
                        let result = (request.execute)(&mut host);
                        if first {
                            if let Some(opened) = host.as_mut() {
                                opened.publish_binding(binding);
                            }
                        }
                        result
                    } else {
                        Ok(Box::new(|_: &mut Session, _| Ok(Vec::new())) as Finish)
                    };
                    (host, result)
                })
                .await;
                let (next, result) = joined.unwrap_or_else(|e| (None, Err(e.into())));
                host = next;
                let (sent, received) = oneshot::channel();
                if output
                    .send(Completion {
                        id: id.clone(),
                        identity: identity.clone(),
                        carrier: request.carrier,
                        result,
                        _accepted: request.accepted,
                        _capacity: capacity,
                        _delivered: sent,
                    })
                    .is_err()
                {
                    break;
                }
                let _ = received.await;
            }
            drop(host);
            released.send_replace(true);
            id
        });
    }
    pub fn post(
        &mut self,
        id: &str,
        local: bool,
        survive_retirement: bool,
        run: impl FnOnce(&mut Option<HostedRoom>) -> Result<Finish> + Send + 'static,
    ) -> Result<()> {
        let slot = self
            .slots
            .get(id)
            .ok_or_else(|| anyhow!("room_unavailable"))?;
        slot.send
            .send(Request {
                execute: Box::new(run),
                accepted: self.admission.clone(),
                carrier: self.carrier.clone(),
                local,
                survive_retirement,
            })
            .map_err(|_| anyhow!("room_owner_stopped"))?;
        #[cfg(test)]
        {
            self.pending += 1;
        }
        Ok(())
    }
    pub fn remove(&mut self, id: &str) -> Option<Slot> {
        let slot = self.slots.remove(id)?;
        slot.identity.store(false, Ordering::Release);
        self.retiring.insert(id.to_string(), slot.released.clone());
        Some(slot)
    }
    pub fn retain(&mut self, mut keep: impl FnMut(&String, &Slot) -> bool) {
        let retired: Vec<_> = self
            .slots
            .iter()
            .filter_map(|(id, s)| (!keep(id, s)).then(|| id.clone()))
            .collect();
        for id in retired {
            self.remove(&id);
        }
    }
    pub fn slot_mut(&mut self, id: &str) -> Option<&mut Slot> {
        self.slots.get_mut(id)
    }
    pub fn completed(&mut self, first_error: &mut Option<anyhow::Error>) {
        #[cfg(test)]
        {
            self.pending -= 1;
        }
        while let Some(task) = self.tasks.try_join_next() {
            if let Err(error) = task {
                first_error.get_or_insert_with(|| error.into());
            }
        }
        self.retiring.retain(|_, released| !*released.borrow());
    }
    pub fn disconnected(&mut self) {
        self.carrier.store(false, Ordering::Release);
        self.admission = None;
    }
    pub fn connected(&mut self) {
        self.disconnected();
        self.carrier = Arc::new(AtomicBool::new(true));
    }
    pub fn stop(&mut self) {
        self.disconnected();
        self.retain(|_, _| false);
        self.output.take();
    }
    pub async fn join(&mut self, first_error: &mut Option<anyhow::Error>) {
        while let Some(task) = self.tasks.join_next().await {
            if let Err(error) = task {
                first_error.get_or_insert_with(|| error.into());
            }
        }
        self.retiring.clear();
    }
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;

    #[tokio::test]
    async fn stopped_actor_closes_completion_stream_and_reports_join_error() {
        let mut rooms = Rooms::with_execution(BTreeMap::new(), Arc::new(Semaphore::new(0)), 1);
        rooms.reserve("pending", Uuid::new_v4());
        rooms
            .post("pending", false, false, |_| Ok(Box::new(|_, _| Ok(vec![]))))
            .unwrap();
        rooms.tasks.abort_all();
        rooms.stop();
        // The task exited before publishing its accepted request.
        assert!(time::timeout(Duration::from_secs(2), rooms.finished.recv())
            .await
            .unwrap()
            .is_none());
        let mut error = None;
        rooms.join(&mut error).await;
        assert!(error
            .unwrap()
            .downcast_ref::<tokio::task::JoinError>()
            .unwrap()
            .is_cancelled());
    }
}
