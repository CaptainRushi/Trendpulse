import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { App } from "./App";
import { Today } from "./pages/Today";
import { RawData } from "./pages/RawData";
import { Sources } from "./pages/Sources";
import { Runs } from "./pages/Runs";
import { Settings } from "./pages/Settings";
import { Wizard } from "./pages/Wizard";
import "./styles/tokens.css";
import "./styles/app.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <Today /> },
      { path: "raw", element: <RawData /> },
      { path: "sources", element: <Sources /> },
      { path: "runs", element: <Runs /> },
      { path: "runs/:runId", element: <Runs /> },
      { path: "settings", element: <Settings /> },
      { path: "wizard", element: <Wizard /> },
    ],
  },
]);

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("TrendPulse: #root element missing from index.html");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
