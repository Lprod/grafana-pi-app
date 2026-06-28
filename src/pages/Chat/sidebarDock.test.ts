import {
  consumeAssistantSidebarDockRequest,
  getAssistantDockRoute,
  rememberAssistantDockRoute,
  routeFromLocation,
  storeAssistantSidebarDockRequest,
} from './sidebarDock';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('Assistant sidebar dock handoff', () => {
  it('stores and consumes a session dock request once', () => {
    const storage = new MemoryStorage();

    storeAssistantSidebarDockRequest({ sessionId: 'session-1', path: '/d/test' }, storage, 1000);

    expect(consumeAssistantSidebarDockRequest(storage, 1000)).toEqual({
      path: '/d/test',
      sessionId: 'session-1',
    });
    expect(consumeAssistantSidebarDockRequest(storage, 1000)).toBeUndefined();
  });

  it('stores and consumes dashboard launch dock props', () => {
    const storage = new MemoryStorage();

    storeAssistantSidebarDockRequest({ action: 'troubleshoot', contextId: 'ctx-1' }, storage, 1000);

    expect(consumeAssistantSidebarDockRequest(storage, 1000)).toEqual({
      action: 'troubleshoot',
      contextId: 'ctx-1',
    });
  });

  it('expires stale dock requests', () => {
    const storage = new MemoryStorage();

    storeAssistantSidebarDockRequest({ sessionId: 'session-1' }, storage, 1000);

    expect(consumeAssistantSidebarDockRequest(storage, 1000 + 120001)).toBeUndefined();
  });

  it('remembers and normalizes the last non-app route', () => {
    const storage = new MemoryStorage();

    rememberAssistantDockRoute('/d/service?orgId=1#panel-7', storage, 1000);

    expect(getAssistantDockRoute(storage, 1000)).toBe('/d/service?orgId=1#panel-7');
  });

  it('ignores external-looking dock routes', () => {
    const storage = new MemoryStorage();

    rememberAssistantDockRoute('https://example.com/d/service', storage, 1000);

    expect(getAssistantDockRoute(storage, 1000)).toBeUndefined();
  });

  it('formats a route from a Grafana location object', () => {
    expect(routeFromLocation({ pathname: '/d/service', search: '?orgId=1', hash: '#panel-7' })).toBe(
      '/d/service?orgId=1#panel-7'
    );
  });
});
