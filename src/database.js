const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

async function trackUser(userId, username) {
  try {
    const { data } = await supabase
      .from("users")
      .select("message_count")
      .eq("user_id", userId)
      .single();

    const newCount = data ? data.message_count + 1 : 1;

    await supabase.from("users").upsert({
      user_id: userId,
      username: username || "Unknown",
      last_used: new Date().toISOString(),
      message_count: newCount
    });
  } catch (err) {
    console.error("Track user error:", err.message);
  }
}

async function getTotalUsers() {
  try {
    const { count } = await supabase
      .from("users")
      .select("*", { count: "exact", head: true });
    return count || 0;
  } catch (err) {
    console.error("Get users error:", err);
    return 0;
  }
}

module.exports = { trackUser, getTotalUsers };
