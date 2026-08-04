/**
 * YAKINIKU RESERVE — Cloudflare Worker (D1 backend + Admin API)
 * ระบบจองที่นั่งร้านเนื้อย่างญี่ปุ่นแบบ exclusive จำกัดที่นั่ง/วัน
 *
 * Env / Secrets:
 *   DB          — D1 binding (ตั้งใน wrangler.toml)
 *   ADMIN_TOKEN — รหัสเข้าหน้าแอดมิน (wrangler secret put ADMIN_TOKEN)
 *   LINE_TOKEN  — LINE Messaging API channel access token (wrangler secret put LINE_TOKEN)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function authAdmin(request, env) {
  const token =
    request.headers.get('Authorization')?.replace('Bearer ', '') ||
    new URL(request.url).searchParams.get('token');
  return token && token === env.ADMIN_TOKEN;
}

// ─── อ่านค่าตั้งค่าทั้งหมดเป็น object ─────────────────────────
async function getSettings(env) {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
  const s = {};
  for (const r of results) s[r.key] = r.value;
  return s;
}

function effectivePrice(s) {
  const promoOn = String(s.promo_on) === '1';
  return promoOn ? Number(s.promo_price || 0) : Number(s.price || 0);
}

// ─── จำนวนที่นั่งที่ถูกจองแล้วในวันนั้น (ไม่นับที่ยกเลิก) ──────
async function bookedSeats(env, date) {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(seats),0) AS booked
       FROM reservations
      WHERE reserve_date = ? AND status != 'ยกเลิก'`
  ).bind(date).first();
  return Number(row?.booked || 0);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ═══════════════════ PUBLIC ═══════════════════

      // ─── ค่าคอนฟิกสาธารณะ (ราคา/โปร/ที่นั่ง/พร้อมเพย์) ───
      if (path === '/api/config' && method === 'GET') {
        const s = await getSettings(env);
        return json({
          shop_name:    s.shop_name || 'YAKINIKU',
          capacity:     Number(s.capacity_per_day || 20),
          price:        Number(s.price || 0),
          promo_price:  Number(s.promo_price || 0),
          promo_on:     String(s.promo_on) === '1',
          price_now:    effectivePrice(s),
          promptpay_id: s.promptpay_id || '',
        });
      }

      // ─── ที่นั่งคงเหลือรายวัน (ปฏิทิน 1 เดือน) ?ym=YYYY-MM ───
      if (path === '/api/availability' && method === 'GET' && url.searchParams.get('ym')) {
        const ym = url.searchParams.get('ym'); // YYYY-MM
        const s = await getSettings(env);
        const cap = Number(s.capacity_per_day || 20);
        const { results } = await env.DB.prepare(
          `SELECT reserve_date AS d, COALESCE(SUM(seats),0) AS booked
             FROM reservations
            WHERE reserve_date LIKE ? AND status != 'ยกเลิก'
            GROUP BY reserve_date`
        ).bind(ym + '-%').all();
        const map = {};
        for (const r of results) map[r.d] = Number(r.booked);
        return json({ capacity: cap, booked: map });
      }

      // ─── ที่นั่งคงเหลือของวันเดียว ?date=YYYY-MM-DD ───
      if (path === '/api/availability' && method === 'GET' && url.searchParams.get('date')) {
        const date = url.searchParams.get('date');
        const s = await getSettings(env);
        const cap = Number(s.capacity_per_day || 20);
        const booked = await bookedSeats(env, date);
        return json({ date, capacity: cap, booked, remaining: Math.max(0, cap - booked) });
      }

      // ─── ตรวจสอบสมาชิก ?user_id=... ───
      if (path === '/api/member' && method === 'GET') {
        const uid = url.searchParams.get('user_id');
        if (!uid) return json({ member: null });
        const m = await env.DB.prepare(
          `SELECT user_id, name, phone FROM members WHERE user_id = ?`
        ).bind(uid).first();
        return json({ member: m || null });
      }

      // ─── สมัคร/อัปเดตสมาชิก ───
      if (path === '/api/member' && method === 'POST') {
        const b = await request.json();
        if (!b.user_id || !b.name) return json({ error: 'ต้องมี user_id และ name' }, 400);
        await env.DB.prepare(
          `INSERT INTO members (user_id, name, phone, picture_url, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             name = excluded.name,
             phone = excluded.phone,
             picture_url = excluded.picture_url`
        ).bind(
          b.user_id, b.name, b.phone || '', b.picture_url || '', new Date().toISOString()
        ).run();
        return json({ ok: true });
      }

      // ─── สร้างการจอง (ต้องเป็นสมาชิก + เช็คที่นั่ง) ───
      if (path === '/api/reservations' && method === 'POST') {
        const b = await request.json();
        const { user_id, reserve_date } = b;
        const seats = Math.max(1, parseInt(b.seats) || 1);

        if (!user_id || !reserve_date) return json({ error: 'ข้อมูลไม่ครบ' }, 400);

        // ต้องเป็นสมาชิกก่อน
        const member = await env.DB.prepare(
          `SELECT * FROM members WHERE user_id = ?`
        ).bind(user_id).first();
        if (!member) return json({ error: 'ต้องสมัครสมาชิกก่อนจอง', code: 'NOT_MEMBER' }, 403);

        // เช็คที่นั่งคงเหลือ
        const s = await getSettings(env);
        const cap = Number(s.capacity_per_day || 20);
        const already = await bookedSeats(env, reserve_date);
        if (already + seats > cap) {
          return json({
            error: 'ที่นั่งไม่พอ', code: 'FULL',
            remaining: Math.max(0, cap - already),
          }, 409);
        }

        const price = effectivePrice(s);
        const amount = price * seats;

        const res = await env.DB.prepare(
          `INSERT INTO reservations
             (timestamp, reserve_date, user_id, name, phone, seats, amount, slip_url, note, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'รอตรวจสอบ')`
        ).bind(
          new Date().toISOString(),
          reserve_date,
          user_id,
          b.name || member.name,
          b.phone || member.phone || '',
          seats,
          amount,
          b.slip_url || '',
          b.note || ''
        ).run();

        const id = res.meta.last_row_id;

        // แจ้ง LINE ผู้จอง
        let lineResult = null;
        if (env.LINE_TOKEN) {
          const text =
            `🎋 ได้รับคำขอจองของคุณ ${b.name || member.name} แล้ว!\n\n` +
            `📅 วันที่: ${thaiDate(reserve_date)}\n` +
            `🪑 จำนวน: ${seats} ที่\n` +
            `💰 ยอดชำระ: ${amount.toLocaleString()} บาท\n` +
            `📌 เลขที่จอง: #${id}\n\n` +
            `ทางร้านกำลังตรวจสอบสลิปการโอน เมื่อยืนยันแล้วจะแจ้งกลับทาง LINE นี้ครับ 🙏`;
          lineResult = await pushLine(user_id, text, env.LINE_TOKEN);
        }

        return json({ ok: true, id, amount, seats, lineResult });
      }

      // ═══════════════════ ADMIN ═══════════════════

      // ─── รายการจองทั้งหมด / กรองตามวัน ?date=YYYY-MM-DD ───
      if (path === '/api/reservations' && method === 'GET') {
        if (!authAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const date = url.searchParams.get('date');
        let stmt;
        if (date) {
          stmt = env.DB.prepare(
            `SELECT * FROM reservations WHERE reserve_date = ? ORDER BY id DESC`
          ).bind(date);
        } else {
          stmt = env.DB.prepare(`SELECT * FROM reservations ORDER BY id DESC LIMIT 500`);
        }
        const { results } = await stmt.all();
        return json(results);
      }

      // ─── สรุปยอดจองรายวันของทั้งเดือน (ปฏิทินแอดมิน) ?ym=YYYY-MM ───
      if (path === '/api/reservations/summary' && method === 'GET') {
        if (!authAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const ym = url.searchParams.get('ym');
        const { results } = await env.DB.prepare(
          `SELECT reserve_date AS d,
                  SUM(CASE WHEN status != 'ยกเลิก' THEN seats ELSE 0 END) AS seats,
                  COUNT(*) AS orders,
                  SUM(CASE WHEN status = 'รอตรวจสอบ' THEN 1 ELSE 0 END) AS pending
             FROM reservations
            WHERE reserve_date LIKE ?
            GROUP BY reserve_date`
        ).bind(ym + '-%').all();
        const s = await getSettings(env);
        return json({ capacity: Number(s.capacity_per_day || 20), days: results });
      }

      // ─── อัปเดตสถานะการจอง + แจ้ง LINE ผู้จอง ───
      const stMatch = path.match(/^\/api\/reservations\/(\d+)\/status$/);
      if (stMatch && method === 'PATCH') {
        if (!authAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const id = stMatch[1];
        const { status, message } = await request.json();

        await env.DB.prepare(`UPDATE reservations SET status = ? WHERE id = ?`)
          .bind(status, id).run();

        const row = await env.DB.prepare(`SELECT * FROM reservations WHERE id = ?`)
          .bind(id).first();

        let lineResult = null;
        if (row && row.user_id && env.LINE_TOKEN) {
          const text = message || buildStatusMessage(row, status);
          lineResult = await pushLine(row.user_id, text, env.LINE_TOKEN);
        }
        return json({ ok: true, lineResult });
      }

      // ─── อ่าน/แก้ไขค่าตั้งค่า ───
      if (path === '/api/settings' && method === 'GET') {
        if (!authAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        return json(await getSettings(env));
      }
      if (path === '/api/settings' && method === 'PATCH') {
        if (!authAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const b = await request.json();
        for (const [k, v] of Object.entries(b)) {
          await env.DB.prepare(
            `INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          ).bind(k, String(v)).run();
        }
        return json({ ok: true });
      }

      // ─── รายชื่อสมาชิก ───
      if (path === '/api/members' && method === 'GET') {
        if (!authAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const { results } = await env.DB.prepare(
          `SELECT user_id, name, phone, created_at FROM members ORDER BY created_at DESC`
        ).all();
        return json(results);
      }

      // ─── ส่งข้อความหาสมาชิกทุกคน (broadcast / นัดแนะ / แจ้งเปลี่ยนแปลง) ───
      if (path === '/api/broadcast' && method === 'POST') {
        if (!authAdmin(request, env)) return json({ error: 'Unauthorized' }, 401);
        const { message, target } = await request.json();
        if (!message) return json({ error: 'ต้องมีข้อความ' }, 400);
        if (!env.LINE_TOKEN) return json({ error: 'ยังไม่ตั้งค่า LINE_TOKEN' }, 400);

        // target: 'all' (สมาชิกทั้งหมด) | 'YYYY-MM-DD' (เฉพาะผู้จองวันนั้น)
        let ids;
        if (target && /^\d{4}-\d{2}-\d{2}$/.test(target)) {
          const { results } = await env.DB.prepare(
            `SELECT DISTINCT user_id FROM reservations
              WHERE reserve_date = ? AND status != 'ยกเลิก'`
          ).bind(target).all();
          ids = results.map(r => r.user_id);
        } else {
          const { results } = await env.DB.prepare(`SELECT user_id FROM members`).all();
          ids = results.map(r => r.user_id);
        }
        ids = ids.filter(Boolean);
        if (!ids.length) return json({ ok: true, sent: 0, note: 'ไม่มีผู้รับ' });

        const result = await multicastLine(ids, message, env.LINE_TOKEN);
        return json({ ok: true, sent: ids.length, result });
      }

      return new Response('Not Found', { status: 404, headers: CORS });
    } catch (e) {
      return json({ error: 'Server error', detail: e.message }, 500);
    }
  },
};

// ═══════════════════ helpers ═══════════════════

function thaiDate(iso) {
  try {
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('th-TH', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch { return iso; }
}

function buildStatusMessage(r, status) {
  const name = r.name || '';
  const dateStr = thaiDate(r.reserve_date);
  if (status === 'ยืนยันแล้ว') {
    return `✅ ยืนยันการจองสำเร็จ คุณ ${name}!\n\n` +
      `📅 ${dateStr}\n🪑 ${r.seats} ที่\n💰 ${Number(r.amount).toLocaleString()} บาท\n📌 เลขที่จอง #${r.id}\n\n` +
      `แล้วพบกันที่ร้านนะครับ 🥩🔥 ทางเชฟเตรียมเนื้อคุณภาพไว้ให้แล้ว ขอบคุณครับ 🙏`;
  }
  if (status === 'ยกเลิก') {
    return `❌ การจอง #${r.id} (${dateStr}) ของคุณ ${name} ถูกยกเลิกแล้วครับ\n` +
      `หากมีข้อสงสัยกรุณาติดต่อทางร้านได้เลยครับ`;
  }
  return `📋 อัปเดตการจอง #${r.id} ของคุณ ${name}: ${status}`;
}

async function pushLine(userId, text, token) {
  try {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: userId, messages: [{ type: 'text', text }] }),
    });
    return { code: res.status, body: await res.text() };
  } catch (e) {
    return { code: 500, body: e.message };
  }
}

// LINE multicast รับได้สูงสุด 500 คน/ครั้ง — แบ่งชุดให้อัตโนมัติ
async function multicastLine(userIds, text, token) {
  const out = [];
  for (let i = 0; i < userIds.length; i += 500) {
    const chunk = userIds.slice(i, i + 500);
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/multicast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: chunk, messages: [{ type: 'text', text }] }),
      });
      out.push({ code: res.status, count: chunk.length, body: await res.text() });
    } catch (e) {
      out.push({ code: 500, count: chunk.length, body: e.message });
    }
  }
  return out;
}
