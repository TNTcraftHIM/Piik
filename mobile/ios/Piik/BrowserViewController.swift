import UIKit
import WebKit

// The shared Web UI owns rooms, approval, media controls and device selection.
// Keeping it in the foreground also keeps the idle Go runtime in its real owner.
final class BrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let web: WKWebView
    private let runtime: PiikRuntime
    private let popup: Bool
    private var observation: NSKeyValueObservation?
    private let spinner = UIActivityIndicatorView(style: .large)
    private let restart = UIButton(type: .system)
    private var trustedPage = false
    var onRestart: () -> Void = {}

    init(runtime: PiikRuntime, configuration: WKWebViewConfiguration? = nil, popup: Bool = false) {
        let configuration = configuration ?? WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        web = WKWebView(frame: .zero, configuration: configuration)
        self.runtime = runtime; self.popup = popup
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Use the programmatic entry point") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Piik"; view.backgroundColor = .systemBackground
        web.navigationDelegate = self; web.uiDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        restart.translatesAutoresizingMaskIntoConstraints = false; restart.isHidden = true
        restart.configuration = .filled(); restart.setTitle(NSLocalizedString("Start Piik", comment: "Start local runtime"), for: .normal)
        restart.addAction(UIAction { [weak self] _ in self?.restart.isEnabled = false; self?.onRestart() }, for: .touchUpInside)
        view.addSubview(web); view.addSubview(spinner); view.addSubview(restart)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor), spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            restart.centerXAnchor.constraint(equalTo: view.centerXAnchor), restart.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            restart.heightAnchor.constraint(greaterThanOrEqualToConstant: 48)
        ])
        observation = web.observe(\.title, options: [.new]) { [weak self] web, _ in self?.title = web.title ?? "Piik" }
        if popup {
            navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close, target: self, action: #selector(closePopup))
            return
        }
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: NSLocalizedString("Back", comment: "Page navigation"),
            style: .plain, target: self, action: #selector(back))
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: UIMenu(children: [
            UIAction(title: NSLocalizedString("App page", comment: "Shared site management")) { [weak self] _ in
                guard let self, let url = self.runtime.managementURL else { return }
                let management = BrowserViewController(runtime: self.runtime, popup: true)
                management.loadViewIfNeeded(); management.web.load(URLRequest(url: url))
                self.present(UINavigationController(rootViewController: management), animated: true)
            },
            UIAction(title: NSLocalizedString("Stop Piik", comment: "Stop runtime and capture"), attributes: .destructive) { [weak self] _ in
                guard let self else { return }
                self.retirePage()
                self.runtime.close { error in
                    self.restart.isHidden = false; self.restart.isEnabled = true
                    if let error { self.showError(error.localizedDescription) }
                }
            }
        ]))
        runtime.ready = { [weak self] address in
            guard let self, let url = URL(string: address) else { return }
            self.spinner.stopAnimating(); self.web.load(URLRequest(url: url))
        }
        runtime.failed = { [weak self] error in
            guard let self else { return }
            self.retirePage()
            self.spinner.stopAnimating(); self.restart.isHidden = false; self.restart.isEnabled = true
            self.showError(error.localizedDescription)
        }
        runtime.accessChanged = { [weak self] in self?.checkSiteAccess() }
        spinner.startAnimating(); runtime.start()
    }
    @objc private func back() { if web.canGoBack { web.goBack() } }
    @objc private func closePopup() { dismiss(animated: true) }
    func retirePage() {
        presentedViewController?.dismiss(animated: false)
        web.stopLoading(); web.load(URLRequest(url: URL(string: "about:blank")!)); web.isHidden = true
    }
    private func checkSiteAccess() {
        if let url = web.url {
            let wasTrusted = trustedPage
            trustedPage = runtime.trusts(url)
            if wasTrusted && !trustedPage, let management = runtime.managementURL {
                web.load(URLRequest(url: management))
            }
        }
        ((presentedViewController as? UINavigationController)?.topViewController as? BrowserViewController)?.checkSiteAccess()
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        trustedPage = webView.url.map(runtime.trusts) ?? false
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        decisionHandler(url.scheme?.lowercased() == "https" || url.absoluteString == "about:blank" ||
                        (url.scheme == "http" && runtime.trusts(url)) ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil, presentedViewController == nil else { return nil }
        let child = BrowserViewController(runtime: runtime, configuration: configuration, popup: true)
        child.loadViewIfNeeded()
        present(UINavigationController(rootViewController: child), animated: true)
        return child.web // WebKit preserves the real opener and requested navigation.
    }
    func webViewDidClose(_ webView: WKWebView) { if popup { closePopup() } }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard frame.isMainFrame, let top = webView.url, runtime.trusts(top),
              top.scheme == origin.protocol, top.host?.lowercased() == origin.host.lowercased(),
              (top.port ?? (top.scheme == "https" ? 443 : 80)) == (origin.port == 0 ? (top.scheme == "https" ? 443 : 80) : origin.port)
        else { decisionHandler(.deny); return }
        decisionHandler(.prompt)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError(NSLocalizedString("The page stopped. Open the App page to reconnect.", comment: "Web process ended"))
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showError(error.localizedDescription) }
    }
    private func showError(_ message: String) {
        guard presentedViewController == nil else { return }
        let alert = UIAlertController(title: "Piik", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: NSLocalizedString("OK", comment: "Dismiss"), style: .default))
        present(alert, animated: true)
    }
}
