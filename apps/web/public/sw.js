// Web push (§8.2 mobile): show notifications and focus the app on click.
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : { title: "Doott Lead OS" };
  event.waitUntil(self.registration.showNotification(data.title || "Doott Lead OS", { body: data.body || "", data: { url: data.url || "/" }, icon: "/icon.svg" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
