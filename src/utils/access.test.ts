import { OrgRole } from '@grafana/data';
import {
  APP_ACCESS_ACTION,
  canUserAccessApp,
  formatAllowedUsersInput,
  parseAllowedUsersInput,
  type AppAccessUser,
} from './access';

const viewer: AppAccessUser = {
  isSignedIn: true,
  login: 'viewer',
  email: 'viewer@example.com',
  orgRole: OrgRole.Viewer,
  isGrafanaAdmin: false,
};

const admin: AppAccessUser = {
  ...viewer,
  login: 'admin',
  email: 'admin@example.com',
  orgRole: OrgRole.Admin,
};

describe('app access policy', () => {
  it('defaults to unrestricted access', () => {
    expect(canUserAccessApp({}, viewer, () => false)).toBe(true);
    expect(canUserAccessApp({}, undefined, () => false)).toBe(true);
  });

  it('allows any request in all mode', () => {
    expect(canUserAccessApp({ accessMode: 'all' }, viewer, () => false)).toBe(true);
    expect(canUserAccessApp({ accessMode: 'all' }, undefined, () => false)).toBe(true);
  });

  it('restricts to admins in admins mode', () => {
    expect(canUserAccessApp({ accessMode: 'admins' }, viewer, () => false)).toBe(false);
    expect(canUserAccessApp({ accessMode: 'admins' }, admin, () => false)).toBe(true);
  });

  it('allows configured users by login or email case-insensitively', () => {
    expect(canUserAccessApp({ accessMode: 'users', allowedUsers: ['VIEWER'] }, viewer, () => false)).toBe(true);
    expect(canUserAccessApp({ accessMode: 'users', allowedUsers: ['viewer@example.com'] }, viewer, () => false)).toBe(
      true
    );
    expect(canUserAccessApp({ accessMode: 'users', allowedUsers: ['other@example.com'] }, viewer, () => false)).toBe(
      false
    );
  });

  it('uses the plugin RBAC action in rbac mode', () => {
    const permissions: string[] = [];
    expect(canUserAccessApp({ accessMode: 'rbac' }, viewer, (action) => permissions.includes(action))).toBe(false);

    permissions.push(APP_ACCESS_ACTION);
    expect(canUserAccessApp({ accessMode: 'rbac' }, viewer, (action) => permissions.includes(action))).toBe(true);
  });

  it('normalizes allowed user input', () => {
    expect(parseAllowedUsersInput(' Alice, bob@example.com\nALICE ')).toEqual(['alice', 'bob@example.com']);
    expect(formatAllowedUsersInput([' Alice ', 'bob@example.com', 'alice'])).toBe('alice\nbob@example.com');
  });
});
