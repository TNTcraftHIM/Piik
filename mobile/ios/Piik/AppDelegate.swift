import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    let session = CompanionSession()
    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Piik", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var companion: CompanionViewController?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        let session = (UIApplication.shared.delegate as! AppDelegate).session
        let companion = CompanionViewController(session: session)
        window.rootViewController = UINavigationController(rootViewController: companion)
        window.makeKeyAndVisible()
        self.window = window; self.companion = companion
        for context in connectionOptions.urlContexts { companion.activate(context.url) }
    }
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        for context in contexts { companion?.activate(context.url) }
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        (UIApplication.shared.delegate as? AppDelegate)?.session.becameActive()
    }
}
