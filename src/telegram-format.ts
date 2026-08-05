export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function shortenAddress(address: string): string {
  if (address.length <= 14) return address;
  return address.slice(0, 8) + "..." + address.slice(-4);
}
