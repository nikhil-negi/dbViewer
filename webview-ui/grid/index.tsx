import type { GridInit } from '../../src/webview/protocol';
import { mount } from '../shared/mount';
import { readInit } from '../shared/vscode';
import { Grid } from './Grid';
import './grid.css';

mount(<Grid init={readInit<GridInit>()} />);
