/**
 * Small fetch wrapper: JSON in, JSON out, errors carry status and a body
 * excerpt. Bodies are never logged in full because provider responses can
 * hold secrets.
 */
export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function request(url, { method = "GET", headers = {}, body, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 200) };
    }
  }
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || data?.raw || "";
    throw new HttpError(`${method} ${redact(url)} -> ${res.status} ${String(detail).slice(0, 200)}`, res.status);
  }
  return data;
}

/** Strip query strings from URLs before they reach logs. */
export function redact(url) {
  return String(url).split("?")[0];
}
