import React from "react";
import { MainLayout } from "./components/layout/MainLayout";
import { SessionProvider } from "./features/session/SessionContext";

const App: React.FC = () => {
  return (
    <SessionProvider>
      <MainLayout />
    </SessionProvider>
  );
};

export default App;

