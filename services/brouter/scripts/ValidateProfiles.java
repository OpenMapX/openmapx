import btools.router.ProfileCache;
import btools.router.RoutingContext;
import java.io.File;

/** Parse every shipped profile with the engine before replacing serving data. */
class ValidateProfiles {
    public static void main(String[] args) {
        File[] profiles = new File(args[0]).listFiles((dir, name) -> name.endsWith(".brf"));
        if (profiles == null || profiles.length == 0) {
            throw new IllegalArgumentException("No BRouter profiles to validate");
        }
        for (File profile : profiles) {
            RoutingContext context = new RoutingContext();
            context.localFunction = profile.getAbsolutePath();
            ProfileCache.parseProfile(context);
            ProfileCache.releaseProfile(context);
        }
    }
}
