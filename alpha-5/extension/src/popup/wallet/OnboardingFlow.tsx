// Parent flow that sequences onboarding sub-screens.
//
//   choose → generate / import → password → onSuccess(status)
//
// We keep the validated phrase in this component's state so refresh
// of the password step doesn't lose the user's input.

import { useState } from "react";
import { OnboardingScreen } from "./OnboardingScreen";
import { GenerateMnemonic } from "./GenerateMnemonic";
import { ImportWallet } from "./ImportWallet";
import { SetPasswordScreen } from "./SetPasswordScreen";
import { NetworkChoiceScreen } from "./NetworkChoiceScreen";
import type { WalletStatus } from "./walletClient";

type Step =
  | { kind: "choose" }
  | { kind: "generate" }
  | { kind: "import" }
  | { kind: "password"; source: "generate" | "import"; phrase: string }
  | { kind: "network"; status: WalletStatus };

export function OnboardingFlow({
  onSuccess,
}: {
  onSuccess: (status: WalletStatus) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "choose" });

  switch (step.kind) {
    case "choose":
      return (
        <OnboardingScreen
          onPick={(mode) => setStep({ kind: mode })}
        />
      );
    case "generate":
      return (
        <GenerateMnemonic
          onBack={() => setStep({ kind: "choose" })}
          onContinue={(phrase) =>
            setStep({ kind: "password", source: "generate", phrase })
          }
        />
      );
    case "import":
      return (
        <ImportWallet
          onBack={() => setStep({ kind: "choose" })}
          onContinue={(phrase) =>
            setStep({ kind: "password", source: "import", phrase })
          }
        />
      );
    case "password":
      return (
        <SetPasswordScreen
          source={step.source}
          phrase={step.phrase}
          onBack={() => setStep({ kind: step.source })}
          // Wallet is unlocked here; pick the chain-access path before the dashboard.
          onSuccess={(status) => setStep({ kind: "network", status })}
        />
      );
    case "network":
      return <NetworkChoiceScreen onDone={() => onSuccess(step.status)} />;
  }
}
