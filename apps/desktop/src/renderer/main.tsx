import { createRoot } from 'react-dom/client';
import '@hangar/theme/fonts.css';
import '@hangar/theme/tokens.css';
import './styles.css';
import { App } from './App';
import { setLocale } from '../messages';

setLocale(window.hangarShell.locale);

createRoot(document.getElementById('root')!).render(<App api={window.hangarShell} />);
