import {
  buildAssistantSidebarPageContextSnapshot,
  renderAssistantSidebarPageContextBlock,
  sidebarPageContextSkillHints,
} from './sidebarPageContext';

describe('assistant sidebar page context', () => {
  it('captures bounded dashboard route context', () => {
    const snapshot = buildAssistantSidebarPageContextSnapshot(
      '/d/service-uid/service-overview?orgId=1&from=now-6h&to=now&timezone=browser&var-job=api&var-instance=a&var-instance=b&viewPanel=7',
      { liveDashboardEditingAvailable: true }
    );

    expect(snapshot).toMatchObject({
      route:
        '/d/service-uid/service-overview?orgId=1&from=now-6h&to=now&timezone=browser&var-job=api&var-instance=a&var-instance=b&viewPanel=7',
      pathname: '/d/service-uid/service-overview',
      pageType: 'dashboard',
      dashboard: {
        uid: 'service-uid',
        slug: 'service-overview',
        routeKind: 'dashboard',
        orgId: '1',
        from: 'now-6h',
        to: 'now',
        timezone: 'browser',
        viewPanel: '7',
        variables: {
          job: 'api',
          instance: ['a', 'b'],
        },
        liveDashboardEditingAvailable: true,
      },
    });
    expect(sidebarPageContextSkillHints(snapshot)).toEqual({
      pageType: 'dashboard',
      hasDashboardContext: true,
      hasPanelContext: true,
      liveDashboardEditingAvailable: true,
    });
  });

  it('captures Explore datasource and query context from the left URL parameter', () => {
    const left = {
      datasource: 'prometheus',
      range: { from: 'now-1h', to: 'now' },
      queries: [
        {
          refId: 'A',
          datasource: { uid: 'prometheus', type: 'prometheus' },
          expr: 'sum(rate(http_requests_total[$__rate_interval]))',
          queryType: 'timeSeriesQuery',
          legendFormat: 'requests',
        },
      ],
    };

    const snapshot = buildAssistantSidebarPageContextSnapshot(
      `/explore?left=${encodeURIComponent(JSON.stringify(left))}`
    );

    expect(snapshot).toMatchObject({
      pageType: 'explore',
      explore: {
        panes: [
          {
            datasourceUid: 'prometheus',
            from: 'now-1h',
            to: 'now',
            queries: [
              {
                refId: 'A',
                datasourceUid: 'prometheus',
                datasourceType: 'prometheus',
                expression: 'sum(rate(http_requests_total[$__rate_interval]))',
                queryType: 'timeSeriesQuery',
              },
            ],
          },
        ],
      },
    });
  });

  it('renders hidden prompt context for Grafana pages but not Assistant pages', () => {
    const dashboard = buildAssistantSidebarPageContextSnapshot('/d/service-uid/service-overview?from=now-6h&to=now');
    const assistant = buildAssistantSidebarPageContextSnapshot('/a/grafana-assistant-app/chat');

    const block = renderAssistantSidebarPageContextBlock(dashboard);

    expect(block).toContain('<current_grafana_context>');
    expect(block).toContain('observed UI state');
    expect(block).toContain('"uid": "service-uid"');
    expect(renderAssistantSidebarPageContextBlock(assistant)).toBeUndefined();
  });

  it('rejects non-relative or empty routes', () => {
    expect(buildAssistantSidebarPageContextSnapshot('https://example.com/d/service')).toBeUndefined();
    expect(buildAssistantSidebarPageContextSnapshot('//example.com/d/service')).toBeUndefined();
    expect(buildAssistantSidebarPageContextSnapshot('')).toBeUndefined();
  });
});
