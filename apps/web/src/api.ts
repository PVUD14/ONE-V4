export type ApiHealth = 'checking' | 'online' | 'offline';

const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL;
export const apiBaseUrl = configuredBaseUrl || 'http://127.0.0.1:3000';

export async function getApiHealth(signal?: AbortSignal): Promise<ApiHealth> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, signal ? { signal } : undefined);
    return response.ok ? 'online' : 'offline';
  } catch {
    return 'offline';
  }
}
