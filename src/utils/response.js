export function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

export function fail(res, message, status = 400, extra = {}) {
  return res.status(status).json({ success: false, error: message, ...extra });
}

export class ApiError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
