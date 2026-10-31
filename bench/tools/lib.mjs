// Helpers the adapters share: finding an element in the text a tool answered with.
export const IDS = { email: "email", password: "password", signIn: "signIn" };
export const LABELS = { email: "Email", password: "Password", signIn: "Sign In" };

/** The first line of text that names the element by its id (or else its label), with the line itself. */
export function lineFor(text, what) {
  const lines = String(text).split("\n");
  const id = IDS[what], label = LABELS[what];
  const byId = lines.find((l) => new RegExp(`(^|[^A-Za-z0-9_])${id}([^A-Za-z0-9_]|$)`).test(l));
  if (byId) return byId;
  return lines.find((l) => l.includes(`"${label}"`)) ?? null;
}

export class TargetError extends Error { constructor(m) { super(m); this.name = "TargetError"; } }
export function need(value, what, tool) {
  if (value === null || value === undefined) throw new TargetError(`${tool}: could not find ${what} in the latest read`);
  return value;
}
