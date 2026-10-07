// Shared caller for the oms-api edge function (customer site and admin console).
export function createOmsApi(supabase, isSupabaseConfigured) {
  return async function api(action, data = {}) {
    if (!isSupabaseConfigured) throw new Error('Ordering service is not configured yet.');
    const result = await supabase.functions.invoke('oms-api', { body: { action, ...data } });
    if (result.error) {
      let message = result.error.message;
      try { const body = await result.error.context?.json(); message = body?.error || message; } catch { /* transport error */ }
      throw new Error(message);
    }
    if (result.data?.error) throw new Error(result.data.error);
    return result.data;
  };
}
