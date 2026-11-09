import { createRoot } from 'react-dom/client';
import '@hangar/theme/fonts.css';
import './styles.css';
import { browserApi } from './api';
import { App } from './App';
import { setLocale } from './messages';

setLocale(window.hangar.locale);
createRoot(document.getElementById('root')!).render(<App api={browserApi(window.hangar)} />);
