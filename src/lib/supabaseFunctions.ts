import { supabase } from "@/integrations/supabase/client";

export async function callEdgeFunction(functionName: string, payload: any, accessToken?: string) {
  // Ensure payload is sent as a JSON string and include auth if provided
  try {
    const res = await supabase.functions.invoke(functionName, {
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    });

    // supabase.functions.invoke resolves with { data, error } when 2xx, but may throw on non-2xx
    return res;
  } catch (err: any) {
    // Normalize the thrown error into the { data, error } shape expected by callers
    console.error("Edge function call error:", err);

    // Try to extract useful information
    const normalizedError: any = {
      message: err?.message ?? String(err),
      name: err?.name ?? "FunctionsHttpError",
    };

    // Some error objects include a response with text/body
    try {
      if (err?.response && typeof err.response.text === "function") {
        const bodyText = await err.response.text();
        normalizedError.details = bodyText;
      }
    } catch (_e) {
      // ignore
    }

    return { data: null, error: normalizedError };
  }
}

export default callEdgeFunction;
