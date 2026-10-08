// Punto de entrada del Worker: /api/* va a la API; lo demás lo sirven los assets de public/.
import { onRequest } from "./api.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) return onRequest({ request, env });
    return env.ASSETS.fetch(request);
  },
};
