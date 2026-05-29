import { OrgRole, type CurrentUserDTO } from '@grafana/data';
import type { PiAppAccessMode, PiAppJsonData } from '../types';

export const APP_ACCESS_ACTION = 'g42-pi-app.app:access';

export type AppAccessUser = Pick<CurrentUserDTO, 'isSignedIn' | 'login' | 'email' | 'orgRole' | 'isGrafanaAdmin'>;

export const accessModeOptions: Array<{ label: string; value: PiAppAccessMode; description: string }> = [
  { label: 'All', value: 'all', description: 'No additional app-level restriction.' },
  { label: 'Admins', value: 'admins', description: 'Only organization admins can use the app.' },
  { label: 'Users', value: 'users', description: 'Organization admins plus listed logins or emails can use the app.' },
  { label: 'RBAC', value: 'rbac', description: `Users need the ${APP_ACCESS_ACTION} permission.` },
];

export function getConfiguredAccessMode(jsonData?: Pick<PiAppJsonData, 'accessMode'>): PiAppAccessMode {
  return isAccessMode(jsonData?.accessMode) ? jsonData.accessMode : 'all';
}

export function canUserAccessApp(
  jsonData: Pick<PiAppJsonData, 'accessMode' | 'allowedUsers'> | undefined,
  user: AppAccessUser | undefined,
  hasNativePermission: (action: string) => boolean
): boolean {
  const mode = getConfiguredAccessMode(jsonData);
  if (mode === 'all') {
    return true;
  }
  if (!user?.isSignedIn) {
    return false;
  }
  if (isAdmin(user)) {
    return true;
  }
  if (mode === 'users') {
    return userMatchesAllowedList(user, jsonData?.allowedUsers);
  }
  if (mode === 'rbac') {
    return hasNativePermission(APP_ACCESS_ACTION);
  }

  return false;
}

export function parseAllowedUsersInput(value: string): string[] {
  return uniqueNormalizedPrincipals(value.split(/[\n,]+/));
}

export function formatAllowedUsersInput(values: string[] | undefined): string {
  return uniqueNormalizedPrincipals(values ?? []).join('\n');
}

export function uniqueNormalizedPrincipals(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizePrincipal(value);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function isAccessMode(value: unknown): value is PiAppAccessMode {
  return value === 'all' || value === 'admins' || value === 'users' || value === 'rbac';
}

function isAdmin(user: AppAccessUser): boolean {
  return user.isGrafanaAdmin || user.orgRole === OrgRole.Admin;
}

function userMatchesAllowedList(user: AppAccessUser, allowedUsers: string[] | undefined): boolean {
  const allowed = new Set(uniqueNormalizedPrincipals(allowedUsers ?? []));
  return allowed.has(normalizePrincipal(user.login)) || allowed.has(normalizePrincipal(user.email));
}

function normalizePrincipal(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}
