import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initializeAppearance } from './appearance.js';
import './style.css';

initializeAppearance();
createRoot(document.getElementById('root')!).render(<App />);
