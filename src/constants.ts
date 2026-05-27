import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;
export const PLUGIN_ID = pluginJson.id;

export enum ROUTES {
  Chat = 'chat',
}
