'use strict';
/* ============================================================
   ⭐ DEPARTMENTS (2026-10-16)
   ------------------------------------------------------------
   The platform now serves every academic department, not only
   Aerospace.

   • `departments` collection — the department list (seeded below,
     insert-only: an existing row is never changed).
   • A course's own department is `course.department` (a slug).
     Courses without it — every course created before this change —
     belong to Aerospace Engineering. Existing course documents are
     NOT modified to say so.
   • `departmentcourses` collection — LINKS that also show a course
     in another department (and which semester it sits in there).
     A linked course is the very same course: one set of materials,
     progress, purchases, quiz results and doubts.
   • One-time migration: every course that existed on 2026-10-16 in
     Semester 1 or 2 is linked into the same semester of every other
     department. Recorded in `migrations` so it never runs twice.

   • Per-department actions (2026-10-16): removing or hiding a course
     INSIDE one department touches only that department —
       – a linked department: the link is deleted / marked hidden;
       – the course's own department: an override row (kind 'own')
         marks it removed / hidden there.
     The course itself, and every other department, stay as they are.

   GET  /api/departments                       public list
   GET  /api/admin/departments/:slug/links      admin: linked courses
   POST /api/admin/departments/:slug/links      admin: { courseId, semester } add a course to a department
   DELETE /api/admin/departments/:slug/links/:courseId   admin: remove a link (the course stays)
   DELETE /api/admin/departments/:slug/courses/:courseId        admin: remove the course from THIS department only
   POST   /api/admin/departments/:slug/courses/:courseId/visibility { hidden }  admin: hide / show it in THIS department only
   ============================================================ */

const DEPARTMENT_NAMES = [
  'Aerospace Engineering',
  'Agricultural and Food Engineering',
  'Architecture and Regional Planning',
  'Artificial Intelligence',
  'Bioscience and Biotechnology',
  'Chemical Engineering',
  'Chemistry',
  'Civil Engineering',
  'Computer Science and Engineering',
  'Education',
  'Electrical Engineering',
  'Electronics and Electrical Communication Engineering',
  'Geology and Geophysics',
  'Humanities and Social Sciences',
  'Industrial and Systems Engineering',
  'Mathematics',
  'Mechanical Engineering',
  'Metallurgical and Materials Engineering',
  'Mining Engineering',
  'Ocean Engineering and Naval Architecture',
  'Physics'
];
const slugify = (s) => String(s).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const DEFAULT_DEPARTMENT = 'aerospace-engineering';
const SEED = DEPARTMENT_NAMES.map((name, i) => ({ slug: slugify(name), name, sortOrder: i }));
const MIGRATION_ID = 'departments-link-sem1-2-2026-10-16';

/* "Semester 1", "1", "Sem-2" → "1" / "2" */
function semNumber(v) {
  const m = String(v == null ? '' : v).match(/\d+/);
  return m ? String(Number(m[0])) : '';
}

module.exports = function departmentsApi(app, deps) {
  const { mongoose, Course, requireAdminAuth, cacheGet, cacheSet, cacheClear, logger } = deps;
  const log = logger || console;

  const Department = mongoose.models.Department || mongoose.model('Department', new mongoose.Schema({
    slug:      { type: String, required: true, unique: true },
    name:      { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
    active:    { type: Boolean, default: true }
  }, { timestamps: true }));

  const linkSchema = new mongoose.Schema({
    department: { type: String, required: true },
    courseId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    semester:   { type: String, default: '' },
    source:     { type: String, default: 'admin' },      // 'migration' | 'admin'
    kind:       { type: String, default: 'link' },       // 'link' | 'own' (override for the course's own department)
    hidden:     { type: Boolean, default: false },       // hidden from students in this department only
    removed:    { type: Boolean, default: false }        // kind 'own': taken out of its own department
  }, { timestamps: true });
  linkSchema.index({ department: 1, courseId: 1 }, { unique: true });
  const DepartmentCourse = mongoose.models.DepartmentCourse || mongoose.model('DepartmentCourse', linkSchema);

  /* ---------- the department list (cached; static list as the fallback) ---------- */
  async function listDepartments() {
    const hit = cacheGet('departments:list');
    if (hit) return hit;
    let rows = [];
    try {
      rows = await Department.find({ active: { $ne: false } }).select('slug name sortOrder').sort({ sortOrder: 1, name: 1 }).lean();
    } catch (e) { log.warn('[departments] list failed:', e.message); }
    const list = (rows.length ? rows : SEED).map(d => ({ slug: d.slug, name: d.name }));
    cacheSet('departments:list', list, 5 * 60 * 1000);
    return list;
  }
  async function isDepartment(slug) {
    return (await listDepartments()).some(d => d.slug === slug);
  }

  /* ---------- course list payloads: add each course's links ---------- */
  async function attachLinks(courses) {
    if (!Array.isArray(courses) || !courses.length) return courses;
    const ids = courses.map(c => c && c._id).filter(Boolean);
    let links = [];
    try {
      links = await DepartmentCourse.find({ courseId: { $in: ids } }).select('department courseId semester kind hidden removed').lean();
    } catch (e) { log.warn('[departments] links lookup failed:', e.message); return courses; }
    const by = new Map();
    for (const l of links) {
      const k = String(l.courseId);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(l);
    }
    for (const c of courses) {
      if (!c) continue;
      c.department = c.department || DEFAULT_DEPARTMENT;
      const rows = by.get(String(c._id)) || [];
      /* the own-department override (only when it is for the CURRENT own department) */
      const own = rows.find(l => l.kind === 'own' && l.department === c.department);
      c.ownState = own ? { hidden: !!own.hidden, removed: !!own.removed } : { hidden: false, removed: false };
      c.deptLinks = rows.filter(l => l.kind !== 'own' && l.department !== c.department)
        .map(l => (l.hidden ? { d: l.department, s: l.semester || '', h: 1 } : { d: l.department, s: l.semester || '' }));
    }
    return courses;
  }

  /* ---------- startup: seed departments, run the one-time linking ---------- */
  (async () => {
    try {
      if (mongoose.connection.readyState !== 1) {
        await new Promise((resolve) => mongoose.connection.once('connected', resolve));
      }
      /* insert-only: never overwrites a department an admin may have edited */
      const seeded = await Department.bulkWrite(SEED.map(d => ({
        updateOne: { filter: { slug: d.slug }, update: { $setOnInsert: d }, upsert: true }
      })), { ordered: false });
      if (seeded.upsertedCount) log.log(`[departments] ✅ added ${seeded.upsertedCount} department(s)`);

      /* Course text index: stop it treating course.language as a search
         language (that made "Language" left empty — or e.g. "Hindi" — fail
         to save a course). Index only; no document changes. */
      try {
        const textIx = (await Course.collection.indexes()).find(i => i.key && i.key._fts === 'text');
        if (textIx && textIx.language_override !== 'textSearchLanguage') {
          await Course.collection.dropIndex(textIx.name);
          log.log('[departments] rebuilt the course text index (language_override)');
        }
        await Course.collection.createIndex({ name: 'text', code: 'text', description: 'text' }, { language_override: 'textSearchLanguage' });
      } catch (e) { log.warn('[departments] course text index:', e.message); }
      /* unique index before any link is written (one link per department + course) */
      await DepartmentCourse.collection.createIndex({ department: 1, courseId: 1 }, { unique: true });
      await DepartmentCourse.collection.createIndex({ courseId: 1 });

      const migrations = mongoose.connection.collection('migrations');
      if (await migrations.findOne({ _id: MIGRATION_ID })) return;

      /* the courses as they are right now (read only) */
      const existing = await Course.find({}).select('_id semester department').lean();
      const targets = SEED.map(d => d.slug).filter(s => s !== DEFAULT_DEPARTMENT);
      const ops = [];
      let courses = 0;
      for (const c of existing) {
        if ((c.department || DEFAULT_DEPARTMENT) !== DEFAULT_DEPARTMENT) continue;
        const sem = semNumber(c.semester);
        if (sem !== '1' && sem !== '2') continue;
        courses++;
        for (const dept of targets) {
          ops.push({ updateOne: {
            filter: { department: dept, courseId: c._id },
            update: { $setOnInsert: { department: dept, courseId: c._id, semester: sem, source: 'migration', createdAt: new Date(), updatedAt: new Date() } },
            upsert: true
          } });
        }
      }
      let made = 0;
      for (let i = 0; i < ops.length; i += 500) {
        const r = await DepartmentCourse.collection.bulkWrite(ops.slice(i, i + 500), { ordered: false });
        made += r.upsertedCount || 0;
      }
      await migrations.insertOne({ _id: MIGRATION_ID, at: new Date(), courses, links: made });
      cacheClear('courses:');
      log.log(`[departments] ✅ linked ${courses} Semester 1/2 course(s) into ${targets.length} departments (${made} links)`);
    } catch (e) {
      log.error('[departments] startup:', e.message);
    }
  })();

  /* ---------- routes ---------- */
  app.get('/api/departments', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ success: true, departments: await listDepartments(), defaultDepartment: DEFAULT_DEPARTMENT });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Could not load departments.' });
    }
  });

  app.get('/api/admin/departments/:slug/links', requireAdminAuth, async (req, res) => {
    try {
      const links = await DepartmentCourse.find({ department: String(req.params.slug) }).select('courseId semester source').lean();
      res.json({ success: true, links: links.map(l => ({ courseId: String(l.courseId), semester: l.semester, source: l.source })) });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error.' }); }
  });

  app.post('/api/admin/departments/:slug/links', requireAdminAuth, async (req, res) => {
    try {
      const slug = String(req.params.slug);
      const courseId = String((req.body || {}).courseId || '');
      if (!(await isDepartment(slug))) return res.status(404).json({ success: false, message: 'Unknown department.' });
      if (!mongoose.Types.ObjectId.isValid(courseId)) return res.status(400).json({ success: false, message: 'Invalid course.' });
      const course = await Course.findById(courseId).select('department semester').lean();
      if (!course) return res.status(404).json({ success: false, message: 'Course not found.' });
      if ((course.department || DEFAULT_DEPARTMENT) === slug) {
        /* its own department: undo an earlier "remove from this department" */
        await DepartmentCourse.updateOne({ department: slug, courseId, kind: 'own' }, { $set: { removed: false, hidden: false } });
        cacheClear('courses:');
        return res.json({ success: true, message: 'Course is back in its own department.' });
      }
      const semester = semNumber((req.body || {}).semester) || semNumber(course.semester);
      await DepartmentCourse.updateOne({ department: slug, courseId },
        { $set: { semester, kind: 'link', removed: false, hidden: false }, $setOnInsert: { source: 'admin' } }, { upsert: true });
      cacheClear('courses:');
      res.json({ success: true, message: 'Course added to the department.' });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error.' }); }
  });

  app.delete('/api/admin/departments/:slug/links/:courseId', requireAdminAuth, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(String(req.params.courseId))) return res.status(400).json({ success: false, message: 'Invalid course.' });
      const r = await DepartmentCourse.deleteOne({ department: String(req.params.slug), courseId: req.params.courseId });
      cacheClear('courses:');
      res.json({ success: true, removed: r.deletedCount || 0, message: 'Removed from this department (the course itself is unchanged).' });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error.' }); }
  });

  /* ---------- per-department remove / hide ---------- */
  /* where a course is listed: { own, ownRow, links } */
  async function membership(courseId) {
    const course = await Course.findById(courseId).select('department semester name').lean();
    if (!course) return null;
    const own = course.department || DEFAULT_DEPARTMENT;
    const rows = await DepartmentCourse.find({ courseId: course._id }).lean();
    const ownRow = rows.find(r => r.kind === 'own' && r.department === own) || null;
    const links = rows.filter(r => r.kind !== 'own' && r.department !== own);
    const places = (ownRow && ownRow.removed ? [] : [own]).concat(links.map(l => l.department));
    return { course, own, ownRow, links, places };
  }

  app.delete('/api/admin/departments/:slug/courses/:courseId', requireAdminAuth, async (req, res) => {
    try {
      const slug = String(req.params.slug), courseId = String(req.params.courseId);
      if (!mongoose.Types.ObjectId.isValid(courseId)) return res.status(400).json({ success: false, message: 'Invalid course.' });
      const m = await membership(courseId);
      if (!m) return res.status(404).json({ success: false, message: 'Course not found.' });
      if (!m.places.includes(slug)) return res.status(404).json({ success: false, message: 'This course is not in that department.' });
      /* never leave a course in no department at all — the admin decides to delete it */
      if (m.places.length === 1) {
        return res.status(409).json({ success: false, code: 'LAST_DEPARTMENT',
          message: 'This is the only department this course is in.' });
      }
      if (slug === m.own) {
        await DepartmentCourse.updateOne({ department: slug, courseId: m.course._id },
          { $set: { kind: 'own', removed: true, hidden: false, semester: semNumber(m.course.semester) }, $setOnInsert: { source: 'admin' } }, { upsert: true });
      } else {
        await DepartmentCourse.deleteOne({ department: slug, courseId: m.course._id });
      }
      cacheClear('courses:');
      log.log(`[departments] removed "${m.course.name}" from ${slug} only (${m.places.length - 1} department(s) left)`);
      res.json({ success: true, message: 'Removed from this department. The course is still in ' + (m.places.length - 1) + ' other department(s).' });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error.' }); }
  });

  app.post('/api/admin/departments/:slug/courses/:courseId/visibility', requireAdminAuth, async (req, res) => {
    try {
      const slug = String(req.params.slug), courseId = String(req.params.courseId);
      const hidden = !!(req.body || {}).hidden;
      if (!mongoose.Types.ObjectId.isValid(courseId)) return res.status(400).json({ success: false, message: 'Invalid course.' });
      const m = await membership(courseId);
      if (!m) return res.status(404).json({ success: false, message: 'Course not found.' });
      if (!m.places.includes(slug)) return res.status(404).json({ success: false, message: 'This course is not in that department.' });
      if (slug === m.own) {
        await DepartmentCourse.updateOne({ department: slug, courseId: m.course._id },
          { $set: { kind: 'own', hidden, removed: false, semester: semNumber(m.course.semester) }, $setOnInsert: { source: 'admin' } }, { upsert: true });
      } else {
        await DepartmentCourse.updateOne({ department: slug, courseId: m.course._id }, { $set: { hidden } });
      }
      cacheClear('courses:');
      res.json({ success: true, hidden, message: hidden ? 'Hidden from students in this department only.' : 'Visible to students in this department again.' });
    } catch (e) { res.status(500).json({ success: false, message: 'Server error.' }); }
  });

  return { attachLinks, isDepartment, listDepartments, DEFAULT_DEPARTMENT, DepartmentCourse, Department };
};
module.exports.DEPARTMENT_NAMES = DEPARTMENT_NAMES;
module.exports.DEFAULT_DEPARTMENT = DEFAULT_DEPARTMENT;
