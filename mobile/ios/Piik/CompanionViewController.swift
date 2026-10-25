import UIKit

// Native chrome owns only session lifetime and system recording consent.
// The system browser keeps room UI, camera, voice and exact-origin approval.
final class CompanionViewController: UIViewController {
    private let session: CompanionSession
    private let detail = UILabel()
    private let start = UIButton(type: .system)
    private let open = UIButton(type: .system)
    private let management = UIButton(type: .system)
    private let stop = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var returningToBrowser = false

    init(session: CompanionSession) { self.session = session; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError("Use the programmatic entry point") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Piik"; view.backgroundColor = .systemBackground
        let symbol = UIImageView(image: UIImage(systemName: "tv"))
        symbol.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 64, weight: .light)
        symbol.tintColor = .label; symbol.contentMode = .scaleAspectFit
        symbol.isAccessibilityElement = false
        let name = UILabel()
        name.text = "Piik"; name.font = .preferredFont(forTextStyle: .largeTitle)
        name.adjustsFontForContentSizeCategory = true; name.textAlignment = .center
        detail.font = .preferredFont(forTextStyle: .body)
        detail.adjustsFontForContentSizeCategory = true; detail.textAlignment = .center; detail.numberOfLines = 0
        detail.textColor = .secondaryLabel; detail.accessibilityTraits.insert(.updatesFrequently)
        configure(start, title: "Start Piik", filled: true) { [weak self] in
            guard let self else { return }
            self.session.start(openBrowser: !self.returningToBrowser)
        }
        configure(open, title: "Open Piik in browser", filled: true) { [weak self] in
            self?.returningToBrowser = false; self?.session.openEntry()
        }
        configure(management, title: "Open App page", filled: false) { [weak self] in self?.session.openManagement() }
        configure(stop, title: "Stop Piik", filled: false) { [weak self] in
            self?.returningToBrowser = false; self?.session.stop()
        }
        stop.tintColor = .systemRed
        let stack = UIStackView(arrangedSubviews: [symbol, name, detail, spinner, start, open, management, stop])
        stack.axis = .vertical; stack.spacing = 18; stack.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll); scroll.addSubview(stack)
        let width = stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48)
        width.priority = .defaultHigh
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 40),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            stack.centerXAnchor.constraint(equalTo: scroll.frameLayoutGuide.centerXAnchor),
            width, stack.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
            symbol.heightAnchor.constraint(equalToConstant: 80)
        ])
        session.changed = { [weak self] in self?.render() }
        session.preparationFinished = { [weak self] in self?.returningToBrowser = true; self?.render() }
        session.browserFailed = { [weak self] in
            guard let self, self.presentedViewController == nil else { return }
            let alert = UIAlertController(title: "Piik", message: NSLocalizedString("The browser could not open Piik. Try again.", comment: "Browser launch failed"), preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: NSLocalizedString("OK", comment: "Dismiss"), style: .default))
            self.present(alert, animated: true)
        }
        render()
    }

    func activate(_ url: URL) {
        // Waking App never approves a Site or starts a backend session.
        guard url.absoluteString == "piik://media" || url.absoluteString == "piik://app" else { return }
        returningToBrowser = true
        loadViewIfNeeded(); render(); session.becameActive()
    }

    private func configure(_ button: UIButton, title: String, filled: Bool, action: @escaping () -> Void) {
        button.configuration = filled ? .filled() : .plain()
        button.configuration?.cornerStyle = .large
        button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 18, bottom: 14, trailing: 18)
        button.setTitle(NSLocalizedString(title, comment: "Native session action"), for: .normal)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.addAction(UIAction { _ in action() }, for: .touchUpInside)
    }

    private func render() {
        let active = session.state == .running
        let pending = session.state == .admitting || session.state == .starting || session.state == .stopping
        let canStart: Bool
        switch session.state { case .stopped, .failed: canStart = true; default: canStart = false }
        start.isHidden = !canStart; open.isHidden = !active; management.isHidden = !active
        stop.isHidden = canStart
        stop.isEnabled = session.state != .stopping
        pending ? spinner.startAnimating() : spinner.stopAnimating()
        spinner.isHidden = !pending
        let text: String
        switch session.state {
        case .stopped:
            text = "Start a session to use Piik in your browser. You can stop it here or in the system session controls."
        case .admitting: text = "Waiting for the system to allow background execution…"
        case .starting: text = "Starting Piik…"
        case .running:
            text = returningToBrowser
                ? "Return to the same browser tab using the browser return button or the app switcher."
                : "Piik is running. Rooms, camera and voice stay in your browser."
        case .stopping: text = "Stopping Piik…"
        case .failed(let reason): detail.text = reason; return
        }
        detail.text = NSLocalizedString(text, comment: "Native session status")
    }
}
