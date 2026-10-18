import { QrCodeDataType, encode } from "uqr";
import "./landing.css";

const QR_TEXT = "https://github.com/byalex33/permaqr";

const DESTINATIONS = [
  { kicker: "Tuesday", title: "Lunch menu", detail: "Soup, grilled cheese, the good cookies" },
  { kicker: "November", title: "Winter hours", detail: "Open from eight until the snow starts" },
  { kicker: "This week", title: "Catering form", detail: "Office lunches for twelve or more" },
  { kicker: "December", title: "Gift cards", detail: "A paper card that still scans" },
];

function mountQr(host: HTMLElement): void {
  const qr = encode(QR_TEXT, { ecc: "H", border: 2 });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${qr.size} ${qr.size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code linking to the PermaQR GitHub repository");
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", String(qr.size));
  background.setAttribute("height", String(qr.size));
  background.setAttribute("fill", "#fbf7ef");
  svg.append(background);

  for (let y = 0; y < qr.size; y++) {
    const row = qr.data[y];
    const kinds = qr.types[y];
    if (!row || !kinds) continue;
    for (let x = 0; x < qr.size; x++) {
      if (!row[x]) continue;
      const finder = kinds[x] === QrCodeDataType.Position;
      const pad = finder ? 0.04 : 0.16;
      const cell = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      cell.setAttribute("x", (x + pad).toFixed(2));
      cell.setAttribute("y", (y + pad).toFixed(2));
      cell.setAttribute("width", (1 - pad * 2).toFixed(2));
      cell.setAttribute("height", (1 - pad * 2).toFixed(2));
      cell.setAttribute("rx", finder ? "0.2" : "0.42");
      cell.setAttribute("fill", "#1b1714");
      if (!finder) cell.setAttribute("class", "mod");
      svg.append(cell);
    }
  }
  host.replaceChildren(svg);
}

function mountCycle(host: HTMLElement): void {
  let index = 0;
  const paint = (): void => {
    const item = DESTINATIONS[index % DESTINATIONS.length];
    if (!item) return;
    host.replaceChildren();
    const kicker = document.createElement("p");
    kicker.className = "phone-kicker";
    kicker.textContent = item.kicker;
    const title = document.createElement("p");
    title.className = "phone-title";
    title.textContent = item.title;
    const detail = document.createElement("p");
    detail.className = "phone-detail";
    detail.textContent = item.detail;
    host.append(kicker, title, detail);
  };
  paint();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  window.setInterval(() => {
    host.classList.add("is-swapping");
    window.setTimeout(() => {
      index += 1;
      paint();
      host.classList.remove("is-swapping");
    }, 180);
  }, 2600);
}

const qrHost = document.querySelector<HTMLElement>("#qr-live");
const phone = document.querySelector<HTMLElement>("#phone-screen");
if (qrHost) mountQr(qrHost);
if (phone) mountCycle(phone);
