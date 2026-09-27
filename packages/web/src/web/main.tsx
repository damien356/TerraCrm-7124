// Entry point referenced by index.html — composition only, real bootstrap
// lives in __main.tsx (template-managed). The returning managed sign-in leg is
// finished in app.tsx (top-level await) before __main mounts React.
import "./__main";
