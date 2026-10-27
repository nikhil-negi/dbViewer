import type { ColumnPickerInit } from '../../src/webview/protocol';
import { mount } from '../shared/mount';
import { readInit } from '../shared/vscode';
import { ColumnPicker } from './ColumnPicker';
import './columnPicker.css';

mount(<ColumnPicker init={readInit<ColumnPickerInit>()} />);
