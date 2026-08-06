const express = require("express");
const { authenticateToken, authorizeRoles } = require("../middleware/auth");
const Announcement = require("../models/Announcement");
const User = require("../models/User");
const { notifyAnnouncement } = require("../utils/notifications");

const router = express.Router();

const VALID_CATEGORIES = [
  "general",
  "event",
  "policy",
  "celebration",
  "update",
  "urgent",
];
const VALID_AUDIENCES = ["all", "admins"];
const VALID_EMOJIS = ["👍", "🎉", "❤️", "👏", "🚀", "👀"];

/** Shape an announcement for a specific viewer (counts + their own state). */
const serialize = (doc, viewer) => {
  const a = doc.toObject ? doc.toObject() : doc;
  const vid = viewer._id.toString();
  const reactionCounts = {};
  let myReaction = null;
  (a.reactions || []).forEach((r) => {
    reactionCounts[r.emoji] = (reactionCounts[r.emoji] || 0) + 1;
    if (r.user && r.user.toString() === vid) myReaction = r.emoji;
  });
  const reads = a.reads || [];
  const result = {
    ...a,
    reactionCounts,
    myReaction,
    readCount: reads.length,
    hasRead: reads.some((u) => u.toString() === vid),
  };
  delete result.reads;
  delete result.reactions;
  return result;
};

/** Base query: this company, not expired, audience the viewer may see. */
const baseQuery = (user) => {
  const q = { company: user.company._id };
  q.$or = [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }];
  if (user.role !== "admin") q.audience = "all";
  return q;
};

/* ------------------------------------------------------------------ */
/*  List announcements (any authenticated user)                        */
/* ------------------------------------------------------------------ */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const { category, search } = req.query;

    const query = baseQuery(req.user);
    if (category && VALID_CATEGORIES.includes(category)) query.category = category;
    if (search && search.trim()) {
      const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$and = [{ $or: [{ title: rx }, { body: rx }, { authorName: rx }] }];
    }

    const items = await Announcement.find(query)
      .populate("author", "name profilePicture position")
      .sort({ pinned: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Announcement.countDocuments(query);

    res.status(200).json({
      announcements: items.map((a) => serialize(a, req.user)),
      pagination: { current: page, pages: Math.ceil(total / limit), total },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load announcements", error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Unread count for the current user                                  */
/* ------------------------------------------------------------------ */
router.get("/unread-count", authenticateToken, async (req, res) => {
  try {
    const query = baseQuery(req.user);
    query.reads = { $ne: req.user._id };
    const count = await Announcement.countDocuments(query);
    res.status(200).json({ count });
  } catch (error) {
    res.status(500).json({ message: "Failed to count announcements", error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Dashboard highlight - posts from the last 24h + anything pinned    */
/* ------------------------------------------------------------------ */
router.get("/dashboard", authenticateToken, async (req, res) => {
  try {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const query = baseQuery(req.user);
    // Auto-feature on the dashboard for one day, plus anything pinned.
    query.$and = [{ $or: [{ createdAt: { $gte: dayAgo } }, { pinned: true }] }];

    const items = await Announcement.find(query)
      .populate("author", "name profilePicture position")
      .sort({ pinned: -1, createdAt: -1 })
      .limit(6);

    res.status(200).json({
      announcements: items.map((a) => serialize(a, req.user)),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load announcements", error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Create an announcement (admin/HR only)                             */
/* ------------------------------------------------------------------ */
router.post("/", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const { title, body, category, audience, pinned, expiresAt } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Title is required" });
    }
    if (!body || !body.trim()) {
      return res.status(400).json({ message: "Content is required" });
    }
    if (category && !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ message: "Invalid category" });
    }
    if (audience && !VALID_AUDIENCES.includes(audience)) {
      return res.status(400).json({ message: "Invalid audience" });
    }

    const announcement = new Announcement({
      company: req.user.company._id,
      author: req.user._id,
      authorName: req.user.name,
      title: title.trim(),
      body: body.trim(),
      category: category || "general",
      audience: audience || "all",
      pinned: !!pinned,
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      reads: [req.user._id], // author has implicitly seen it
    });
    await announcement.save();
    await announcement.populate("author", "name profilePicture position");

    res.status(201).json({
      message: "Announcement posted",
      announcement: serialize(announcement, req.user),
    });

    // Notify the audience in the background (fire-and-forget - never blocks the
    // post, and a notification hiccup must not fail the request).
    (async () => {
      try {
        const filter = {
          company: req.user.company._id,
          isActive: true,
          status: "active",
          _id: { $ne: req.user._id },
        };
        if (announcement.audience === "admins") filter.role = "admin";
        const recipients = await User.find(filter).select("_id");
        await Promise.all(
          recipients.map((u) => notifyAnnouncement(announcement, u._id, req.user))
        );
      } catch (err) {
        console.error("Announcement fan-out failed:", err.message);
      }
    })();
  } catch (error) {
    res.status(500).json({ message: "Failed to post announcement", error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Update an announcement (admin/HR only, same company)               */
/* ------------------------------------------------------------------ */
router.put("/:id", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const announcement = await Announcement.findOne({
      _id: req.params.id,
      company: req.user.company._id,
    });
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const { title, body, category, audience, pinned, expiresAt } = req.body;
    if (title !== undefined) announcement.title = String(title).trim();
    if (body !== undefined) announcement.body = String(body).trim();
    if (category !== undefined) {
      if (!VALID_CATEGORIES.includes(category)) {
        return res.status(400).json({ message: "Invalid category" });
      }
      announcement.category = category;
    }
    if (audience !== undefined) {
      if (!VALID_AUDIENCES.includes(audience)) {
        return res.status(400).json({ message: "Invalid audience" });
      }
      announcement.audience = audience;
    }
    if (pinned !== undefined) announcement.pinned = !!pinned;
    if (expiresAt !== undefined) {
      announcement.expiresAt = expiresAt ? new Date(expiresAt) : undefined;
    }

    await announcement.save();
    await announcement.populate("author", "name profilePicture position");
    res.status(200).json({
      message: "Announcement updated",
      announcement: serialize(announcement, req.user),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to update announcement", error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Delete an announcement (admin/HR only, same company)               */
/* ------------------------------------------------------------------ */
router.delete("/:id", authenticateToken, authorizeRoles("admin"), async (req, res) => {
  try {
    const deleted = await Announcement.findOneAndDelete({
      _id: req.params.id,
      company: req.user.company._id,
    });
    if (!deleted) {
      return res.status(404).json({ message: "Announcement not found" });
    }
    res.status(200).json({ message: "Announcement deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete announcement", error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Mark as read (any authenticated user)                              */
/* ------------------------------------------------------------------ */
router.post("/:id/read", authenticateToken, async (req, res) => {
  try {
    const announcement = await Announcement.findOneAndUpdate(
      { _id: req.params.id, company: req.user.company._id },
      { $addToSet: { reads: req.user._id } },
      { new: true }
    );
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }
    res.status(200).json({ readCount: announcement.reads.length });
  } catch (error) {
    res.status(500).json({ message: "Failed to mark as read", error: error.message });
  }
});

/* ------------------------------------------------------------------ */
/*  Toggle an emoji reaction (any authenticated user)                  */
/* ------------------------------------------------------------------ */
router.post("/:id/reactions", authenticateToken, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji || !VALID_EMOJIS.includes(emoji)) {
      return res.status(400).json({ message: "Invalid reaction" });
    }
    const announcement = await Announcement.findOne({
      _id: req.params.id,
      company: req.user.company._id,
    });
    if (!announcement) {
      return res.status(404).json({ message: "Announcement not found" });
    }

    const vid = req.user._id.toString();
    const existing = announcement.reactions.find((r) => r.user.toString() === vid);
    if (existing && existing.emoji === emoji) {
      // same emoji → remove (toggle off)
      announcement.reactions = announcement.reactions.filter(
        (r) => r.user.toString() !== vid
      );
    } else {
      // replace the viewer's reaction with the new emoji (one per user)
      announcement.reactions = announcement.reactions.filter(
        (r) => r.user.toString() !== vid
      );
      announcement.reactions.push({ user: req.user._id, emoji });
    }
    await announcement.save();
    await announcement.populate("author", "name profilePicture position");
    res.status(200).json({ announcement: serialize(announcement, req.user) });
  } catch (error) {
    res.status(500).json({ message: "Failed to react", error: error.message });
  }
});

module.exports = router;
