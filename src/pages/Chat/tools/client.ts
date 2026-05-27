import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { PLUGIN_ID } from '../../../constants';
import { compactParams } from './result';

export async function backendFetch<T>(
  url: string,
  options: { method?: string; data?: unknown; params?: Record<string, unknown> } = {}
): Promise<T> {
  const response = await lastValueFrom(
    getBackendSrv().fetch<T>({
      url,
      method: options.method ?? 'GET',
      data: options.data,
      params: compactParams(options.params),
      showErrorAlert: false,
    })
  );
  return response.data;
}

export async function pluginResourceFetch<T>(
  path: string,
  options: { method?: string; data?: unknown; params?: Record<string, unknown> } = {}
): Promise<T> {
  return backendFetch<T>(`/api/plugins/${PLUGIN_ID}/resources${path}`, options);
}
