/**
 * Guards for the physical device and for deployment-wide settings.
 *
 *  - requireDeviceOwner: an admin of the device-owning company. Door unlock,
 *    machine reads/sync, device rosters and deployment-wide policies.
 *  - requireDeviceTenant: any active user of the device-owning company.
 *    Attendance records only exist for that company; other tenants must not
 *    read them.
 *  - validateDeviceTarget: any device address in the path or body must be a
 *    private-network IPv4 address on the device port. Without this the server
 *    could be pointed at arbitrary hosts (SSRF / port scanning).
 *
 * All expect authenticateToken to have run first.
 */
const net = require("net");
const { isDeviceCompanyUser } = require("../services/deviceOwner");
const audit = require("../services/auditLog");

const denyUnresolved = (res, error) => {
  console.error("Device ownership unresolved:", error.message);
  return res.status(503).json({
    message: "The attendance device is not assigned to a company on this server.",
    code: "DEVICE_OWNER_UNRESOLVED",
  });
};

const requireDeviceTenant = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Authentication required" });
  try {
    if (await isDeviceCompanyUser(req.user)) return next();
  } catch (error) {
    return denyUnresolved(res, error);
  }
  return res.status(403).json({ message: "Attendance data is not available for your organization" });
};

const requireDeviceOwner = async (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "Authentication required" });
  if (req.user.role !== "admin") {
    return res.status(403).json({ message: "You are not authorized to access this resource" });
  }
  try {
    if (await isDeviceCompanyUser(req.user)) return next();
  } catch (error) {
    return denyUnresolved(res, error);
  }
  audit.record({
    req,
    action: "device.access.denied",
    outcome: "denied",
    metadata: { method: req.method, path: req.originalUrl.split("?")[0] },
  });
  return res.status(403).json({ message: "You are not authorized to control this device" });
};

const isPrivateIPv4 = (value) => {
  if (net.isIPv4(value) !== true) return false;
  const [a, b] = value.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

const allowedPorts = () =>
  new Set(
    String(process.env.DEVICE_PORT || process.env.ZKTECO_PORT || "4370")
      .split(",")
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0)
  );

const validateDeviceTarget = (req, res, next) => {
  const reject = () =>
    res.status(400).json({ message: "Device address must be a private network IPv4 address" });

  // Any path segment that looks like a host (has a dot or colon) is a device
  // address. Employee codes, ids and dates never contain either.
  const segments = req.path
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch (_) {
        return s;
      }
    });
  for (const segment of segments) {
    if ((segment.includes(".") || segment.includes(":")) && !isPrivateIPv4(segment)) {
      return reject();
    }
  }

  const body = req.body || {};
  if (body.ip !== undefined && body.ip !== null && body.ip !== "") {
    if (typeof body.ip !== "string" || !isPrivateIPv4(body.ip.trim())) return reject();
  }
  if (body.port !== undefined && body.port !== null && body.port !== "") {
    if (!allowedPorts().has(Number(body.port))) {
      return res.status(400).json({ message: "Device port is not allowed" });
    }
  }
  next();
};

module.exports = {
  requireDeviceOwner,
  requireDeviceTenant,
  validateDeviceTarget,
  isPrivateIPv4,
};
