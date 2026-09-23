import React from "react";
import {createRoot} from "react-dom/client";
import {AuthGate} from '../app/auth-gate';
import Workspace from "../app/workspace";
import "../app/globals.css";
createRoot(document.getElementById("root")!).render(<React.StrictMode><AuthGate><Workspace/></AuthGate></React.StrictMode>);
