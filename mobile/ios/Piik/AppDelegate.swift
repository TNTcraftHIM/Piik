import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Piik", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var runtime: PiikRuntime?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let runtime = PiikRuntime()
        let browser = BrowserViewController(runtime: runtime)
        browser.onRestart = { [weak self] in self?.restart(runtime) }
        window.rootViewController = UINavigationController(rootViewController: browser)
        window.makeKeyAndVisible()
        self.window = window; self.runtime = runtime
    }
    private func restart(_ previous: PiikRuntime) {
        previous.close { [weak self] error in
            guard let self, self.runtime === previous else { return }
            if let error { previous.failed(error); return }
            let next = PiikRuntime()
            let browser = BrowserViewController(runtime: next)
            browser.onRestart = { [weak self] in self?.restart(next) }
            self.runtime = next
            self.window?.rootViewController = UINavigationController(rootViewController: browser)
        }
    }
    func sceneDidBecomeActive(_ scene: UIScene) { runtime?.becameActive() }
}
