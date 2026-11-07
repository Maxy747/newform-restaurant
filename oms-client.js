// Shared caller for the oms-api edge function (customer site and admin console).

// A request that never reached the server (no internet, DNS, captive wifi). The admin queues
// these for later instead of reporting them as refusals.
export class OfflineError extends Error {
  constructor(message = 'No internet connection. This needs the internet.') {
    super(message);
    this.name = 'OfflineError';
    this.offline = true;
  }
}

const NETWORK_MESSAGE = /failed to fetch|failed to send a request|networkerror|network request failed|load failed|fetch failed|internet/i;
export function isOfflineError(error) {
  if (!error) return false;
  if (error.offline === true) return true;
  if (['FunctionsFetchError', 'FunctionsRelayError', 'AuthRetryableFetchError'].includes(error.name)) return true;
  return NETWORK_MESSAGE.test(String(error.message || ''));
}

export function createOmsApi(supabase, isSupabaseConfigured) {
  return async function api(action, data = {}) {
    if (!isSupabaseConfigured) throw new Error('Ordering service is not configured yet.');
    let result;
    try { result = await supabase.functions.invoke('oms-api', { body: { action, ...data } }); }
    catch (error) { if (isOfflineError(error)) throw new OfflineError(); throw error; }
    if (result.error) {
      if (isOfflineError(result.error)) throw new OfflineError();
      let message = result.error.message;
      try { const body = await result.error.context?.json(); message = body?.error || message; } catch { /* transport error */ }
      throw new Error(message);
    }
    if (result.data?.error) throw new Error(result.data.error);
    return result.data;
  };
}
