export default function manifest() {
  return {
    id: "/",
    name: "Locker",
    short_name: "Locker",
    description: "Collect and manage package IDs, even without a network connection.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
}
