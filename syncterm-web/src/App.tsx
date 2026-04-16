import React from "react";
import { MainLayout } from "./components/layout/MainLayout";
import { ExtensionProvider } from "./features/extensions/ExtensionContext";
import { ExtensionRuntimeProvider } from "./features/extensions/ExtensionRuntimeContext";
import { SessionProvider } from "./features/session/SessionContext";

const App: React.FC = () => {
  return (
    <SessionProvider>
      <ExtensionProvider>
        <ExtensionRuntimeProvider>
          <MainLayout />
        </ExtensionRuntimeProvider>
      </ExtensionProvider>
    </SessionProvider>
  );
};

export default App;

