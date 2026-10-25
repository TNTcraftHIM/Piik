import UIKit
import WebKit
import ReplayKit

// The same hosted Web application owns rooms, playback, camera and room voice.
// This shell does not advertise an unimplemented native capture connection.
final class BrowserViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let web: WKWebView
    private let popup: Bool
    private var observation: NSKeyValueObservation?
    private var capture: AnyObject?

    init(configuration: WKWebViewConfiguration? = nil, popup: Bool = false) {
        let configuration = configuration ?? WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        self.web = WKWebView(frame: .zero, configuration: configuration)
        self.popup = popup
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("Use the programmatic entry point") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Piik"
        view.backgroundColor = .systemBackground
        web.navigationDelegate = self
        web.uiDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        observation = web.observe(\.title, options: [.new]) { [weak self] web, _ in
            self?.title = web.title ?? "Piik"
        }
        if popup {
            navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .close,
                target: self, action: #selector(closePopup))
        } else {
            navigationItem.leftBarButtonItem = UIBarButtonItem(title: NSLocalizedString("Back", comment: "Page navigation"),
                style: .plain, target: self, action: #selector(back))
            navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"),
                menu: UIMenu(children: [
                    UIAction(title: NSLocalizedString("Open site", comment: "URL navigation")) { [weak self] _ in self?.openSite() },
                    UIAction(title: NSLocalizedString("Capture probe", comment: "Local developer capture probe")) { [weak self] _ in self?.captureProbe() },
                    UIAction(title: NSLocalizedString("Stop capture probe", comment: "Stop local developer probe")) { [weak self] _ in
                        if #available(iOS 27.0, *) { (self?.capture as? ScreenCaptureProbe)?.close() }
                        else { self?.showError(NSLocalizedString("Stop the capture probe using the system recording indicator.", comment: "ReplayKit stop guidance")) }
                    }
                ]))
            web.load(URLRequest(url: URL(string: "https://demo.piik.tv")!))
        }
    }

    @objc private func back() { if web.canGoBack { web.goBack() } }
    @objc private func closePopup() { dismiss(animated: true) }

    private func captureProbe() {
        if #available(iOS 27.0, *) {
            let dialog = UIAlertController(title: NSLocalizedString("Local capture probe", comment: "Developer probe"),
                message: NSLocalizedString("Tests screen capture and H.264 locally. No media is sent to a room.", comment: "Probe boundary"), preferredStyle: .alert)
            dialog.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: "Cancel"), style: .cancel))
            dialog.addAction(UIAlertAction(title: NSLocalizedString("Continue", comment: "Open system capture picker"), style: .default) { [weak self] _ in
                guard let self else { return }
                let probe = (self.capture as? ScreenCaptureProbe) ?? ScreenCaptureProbe()
                self.capture = probe
                probe.present()
            })
            present(dialog, animated: true)
            return
        }
        let page = UIViewController()
        page.view.backgroundColor = .systemBackground
        page.title = NSLocalizedString("Local capture probe", comment: "Developer probe")
        let text = UILabel()
        text.text = NSLocalizedString("Tests ReplayKit and H.264 locally. No media is sent to a room. Stop using the system recording indicator.", comment: "Probe boundary")
        text.numberOfLines = 0
        let picker = RPSystemBroadcastPickerView(frame: .zero)
        picker.preferredExtension = Bundle.main.bundleIdentifier! + ".Broadcast"
        // ReplayKit owns this system control; keep it visible rather than hide
        // a microphone choice retained by the OS. The probe discards mic buffers.
        picker.showsMicrophoneButton = true
        let stack = UIStackView(arrangedSubviews: [text, picker])
        stack.axis = .vertical
        stack.spacing = 24
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        page.view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: page.view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: page.view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: page.view.safeAreaLayoutGuide.topAnchor, constant: 32),
            picker.widthAnchor.constraint(equalToConstant: 64), picker.heightAnchor.constraint(equalToConstant: 64)
        ])
        present(UINavigationController(rootViewController: page), animated: true)
    }

    @objc private func openSite() {
        let dialog = UIAlertController(title: NSLocalizedString("Open Piik site", comment: "URL entry"),
            message: NSLocalizedString("Opening another site leaves the current page.", comment: "Navigation confirmation"), preferredStyle: .alert)
        dialog.addTextField { field in
            field.placeholder = "https://demo.piik.tv"
            field.keyboardType = .URL
            field.autocapitalizationType = .none
            field.autocorrectionType = .no
            field.textContentType = .URL
        }
        dialog.addAction(UIAlertAction(title: NSLocalizedString("Cancel", comment: "Cancel"), style: .cancel))
        dialog.addAction(UIAlertAction(title: NSLocalizedString("Open", comment: "Open URL"), style: .default) { [weak self, weak dialog] _ in
            guard let self, let text = dialog?.textFields?.first?.text,
                  let url = SiteAddress.url(text) else {
                self?.showError(NSLocalizedString("Enter a valid HTTPS site or invitation URL.", comment: "Invalid site"))
                return
            }
            self.web.load(URLRequest(url: url))
        })
        present(dialog, animated: true)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // No custom scheme commands, TLS exceptions, file access or injected JS API.
        decisionHandler(url.scheme?.lowercased() == "https" || url.absoluteString == "about:blank" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard navigationAction.targetFrame == nil, presentedViewController == nil else { return nil }
        let child = BrowserViewController(configuration: configuration, popup: true)
        child.loadViewIfNeeded()
        // Return the configured child: WebKit retains the real window.opener.
        let navigation = UINavigationController(rootViewController: child)
        present(navigation, animated: true)
        return child.web
    }

    func webViewDidClose(_ webView: WKWebView) { if popup { closePopup() } }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        guard frame.isMainFrame, let top = webView.url,
              top.scheme == "https", top.host?.lowercased() == origin.host.lowercased(),
              (top.port ?? 443) == (origin.port == 0 ? 443 : origin.port), origin.protocol == "https" else {
            decisionHandler(.deny)
            return
        }
        // Standard WebKit origin prompt plus iOS camera/microphone permission.
        decisionHandler(.prompt)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        showError(NSLocalizedString("The page stopped. Open the site again to reconnect.", comment: "Web process ended"))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showError(error.localizedDescription) }
    }

    private func showError(_ message: String) {
        guard presentedViewController == nil else { return }
        let dialog = UIAlertController(title: "Piik", message: message, preferredStyle: .alert)
        dialog.addAction(UIAlertAction(title: NSLocalizedString("OK", comment: "Dismiss"), style: .default))
        present(dialog, animated: true)
    }

    deinit {
        if #available(iOS 27.0, *) { (capture as? ScreenCaptureProbe)?.close() }
    }
}
