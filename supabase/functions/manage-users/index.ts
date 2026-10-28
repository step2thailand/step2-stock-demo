import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return json({ error: "Server configuration is incomplete" }, 500);
  }

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "กรุณาเข้าสู่ระบบใหม่" }, 401);

  // Verify the caller with their own access token, then check the existing database-backed admin policy.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userResult, error: userError } = await callerClient.auth.getUser();
  if (userError || !userResult.user) return json({ error: "เซสชันไม่ถูกต้องหรือหมดอายุ" }, 401);

  const { data: isAdmin, error: adminError } = await callerClient.rpc("is_app_admin");
  if (adminError || isAdmin !== true) return json({ error: "คำสั่งนี้อนุญาตเฉพาะ Admin" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "ข้อมูลคำขอไม่ถูกต้อง" }, 400); }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const action = body.action;

  if (action === "list") {
    const { data, error } = await adminClient.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) return json({ error: "โหลดรายชื่อผู้ใช้ไม่สำเร็จ" }, 500);
    const users = data.users.map((user) => ({
      id: user.id,
      username: user.email?.endsWith("@step2-stock-demo.invalid")
        ? user.email.slice(0, -"@step2-stock-demo.invalid".length)
        : (typeof user.user_metadata?.username === "string" ? user.user_metadata.username : user.email || "(ไม่มี username)"),
      created_at: user.created_at,
    })).sort((a, b) => a.username.localeCompare(b.username));
    return json({ users });
  }

  if (action === "create") {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      return json({ error: "Username ต้องมี 3–32 ตัว ใช้ a-z, 0-9, จุด ขีดกลาง หรือขีดล่าง" }, 400);
    }
    if (password.length < 8 || password.length > 72) {
      return json({ error: "Password ต้องมี 8–72 ตัวอักษร" }, 400);
    }
    const email = username + "@step2-stock-demo.invalid";
    const { data, error } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, account_type: "warehouse_staff" },
    });
    if (error) {
      const message = error.message.toLowerCase().includes("already")
        ? "Username นี้มีอยู่แล้ว กรุณาใช้ชื่ออื่น"
        : "สร้างบัญชีไม่สำเร็จ: " + error.message;
      return json({ error: message }, 400);
    }
    return json({ user: { id: data.user.id, username, created_at: data.user.created_at } }, 201);
  }

  if (action === "delete") {
    const userId = typeof body.user_id === "string" ? body.user_id : "";
    if (!userId) return json({ error: "ไม่พบรหัสผู้ใช้ที่ต้องการลบ" }, 400);
    if (userId === userResult.user.id) return json({ error: "ไม่อนุญาตให้ลบบัญชีของตัวเอง" }, 400);

    // Only remove accounts created for this inventory app; never delete unrelated Supabase Auth users.
    const { data: targetResult, error: targetError } = await adminClient.auth.admin.getUserById(userId);
    if (targetError || !targetResult.user) return json({ error: "ไม่พบบัญชีผู้ใช้" }, 404);
    const target = targetResult.user;
    if (!target.email?.endsWith("@step2-stock-demo.invalid")) {
      return json({ error: "ลบได้เฉพาะบัญชี Username ของ WANGANUBAL INVENTORY" }, 400);
    }

    // Fail closed if role lookup fails, and never allow an Admin account to be deleted here.
    const { data: targetAdmin, error: targetRoleError } = await adminClient
      .from("app_roles")
      .select("user_id")
      .eq("user_id", userId)
      .eq("role", "admin")
      .maybeSingle();
    if (targetRoleError) {
      return json({ error: "ตรวจสอบสิทธิ์ของบัญชีเป้าหมายไม่สำเร็จ จึงยกเลิกการลบ" }, 500);
    }
    if (targetAdmin) {
      return json({ error: "ไม่อนุญาตให้ลบบัญชี Admin ผ่านเมนูนี้" }, 403);
    }

    const { error } = await adminClient.auth.admin.deleteUser(userId);
    if (error) return json({ error: "ลบบัญชีไม่สำเร็จ: " + error.message }, 400);
    return json({ success: true });
  }

  return json({ error: "ไม่รองรับคำสั่งนี้" }, 400);
});
