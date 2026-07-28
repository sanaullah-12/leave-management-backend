/**
 * socketEvents.js
 * ---------------
 * Single source of truth for every real-time event name and room-key builder.
 * Shared by the server emitters and mirrored on the client, so there are no
 * magic strings scattered across the codebase.
 *
 * Rooms are ALWAYS scoped by company id, which enforces multi-tenant isolation:
 * an emit can never leak to another company, and role rooms let us target only
 * admins or only employees.
 */

// ── Server → Client events ────────────────────────────────────────────────
const EVENTS = Object.freeze({
  // Notification centre / bell / toasts
  NOTIFICATION_NEW: "notification:new",

  // Leave lifecycle
  LEAVE_NEW: "leave:new", // employee submitted → admins
  LEAVE_REVIEWED: "leave:reviewed", // admin approved/rejected → employee

  // Employee Voice
  VOICE_NEW: "voice:new", // employee submitted → admins
  VOICE_UPDATED: "voice:updated", // reply / status change → both parties

  // Announcements
  ANNOUNCEMENT_NEW: "announcement:new",

  // Attendance
  ATTENDANCE_UPDATE: "attendance:update",

  // Live dashboard statistics (lightweight signal → client refetches once)
  STATS_UPDATE: "stats:update",

  // Presence (online users) — future-ready
  PRESENCE_UPDATE: "presence:update",

  // Connection lifecycle helpers
  CONNECTED: "server:connected",
});

// ── Client → Server events ────────────────────────────────────────────────
const CLIENT_EVENTS = Object.freeze({
  PRESENCE_GET: "presence:get",
});

// ── Room key builders (company-scoped) ────────────────────────────────────
const ROOMS = Object.freeze({
  /** A single user (all their devices/tabs). */
  user: (userId) => `user:${userId}`,
  /** Everyone in a company. */
  company: (companyId) => `company:${companyId}`,
  /** A role within a company, e.g. company:123:role:admin. */
  companyRole: (companyId, role) => `company:${companyId}:role:${role}`,
  /** Convenience helpers. */
  companyAdmins: (companyId) => `company:${companyId}:role:admin`,
  companyEmployees: (companyId) => `company:${companyId}:role:employee`,
});

module.exports = { EVENTS, CLIENT_EVENTS, ROOMS };
