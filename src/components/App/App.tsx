import React from 'react';
import { SceneApp, useSceneApp } from '@grafana/scenes';
import { AppRootProps } from '@grafana/data';
import { config, hasPermission } from '@grafana/runtime';
import { Alert } from '@grafana/ui';
import { PluginPropsContext } from '../../utils/utils.plugin';
import { chatPage } from '../../pages/Chat/chatPage';
import { canUserAccessApp } from '../../utils/access';
import type { PiAppJsonData } from '../../types';

function getSceneApp() {
  return new SceneApp({
    pages: [chatPage],
    urlSyncOptions: {
      updateUrlOnInit: true,
      createBrowserHistorySteps: true,
    },
  });
}

function AppWithScenes() {
  const scene = useSceneApp(getSceneApp);

  return <scene.Component model={scene} />;
}

function App(props: AppRootProps) {
  const jsonData = (props.meta.jsonData ?? {}) as PiAppJsonData;
  const user = config.bootData.user;
  const hasAccess = canUserAccessApp(jsonData, user, hasPermission);

  if (!hasAccess) {
    return (
      <Alert severity="warning" title="Access denied">
        You do not have permission to use Assistant.
      </Alert>
    );
  }

  return (
    <PluginPropsContext.Provider value={props}>
      <AppWithScenes />
    </PluginPropsContext.Provider>
  );
}

export default App;
