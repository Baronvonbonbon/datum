import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SettingsProvider } from "./context/SettingsContext";
import { WalletProvider } from "./context/WalletContext";
import { Layout } from "./components/Layout";

// Explorer
import { Overview } from "./pages/explorer/Overview";
import { Campaigns } from "./pages/explorer/Campaigns";
import { CampaignDetail } from "./pages/explorer/CampaignDetail";
import { Publishers } from "./pages/explorer/Publishers";
import { HowItWorks } from "./pages/explorer/HowItWorks";

// Advertiser
import { AdvertiserDashboard } from "./pages/advertiser/Dashboard";
import { CreateCampaign } from "./pages/advertiser/CreateCampaign";
import { AdvertiserCampaignDetail } from "./pages/advertiser/CampaignDetail";
import { SetMetadata } from "./pages/advertiser/SetMetadata";
import { CampaignAnalytics } from "./pages/advertiser/Analytics";

// Publisher
import { PublisherDashboard } from "./pages/publisher/Dashboard";
import { Register } from "./pages/publisher/Register";
import { TakeRate } from "./pages/publisher/TakeRate";
import { Categories } from "./pages/publisher/Categories";
import { Allowlist } from "./pages/publisher/Allowlist";
import { Earnings } from "./pages/publisher/Earnings";
import { SDKSetup } from "./pages/publisher/SDKSetup";
import { PublisherProfile } from "./pages/publisher/Profile";

// Governance
import { GovernanceDashboard } from "./pages/governance/Dashboard";
import { Vote } from "./pages/governance/Vote";
import { MyVotes } from "./pages/governance/MyVotes";
import { GovernanceParameters } from "./pages/governance/Parameters";

// Admin
import { TimelockAdmin } from "./pages/admin/Timelock";
import { PauseRegistryAdmin } from "./pages/admin/PauseRegistry";
import { BlocklistAdmin } from "./pages/admin/Blocklist";
import { ProtocolFeesAdmin } from "./pages/admin/ProtocolFees";
import { RateLimiterAdmin } from "./pages/admin/RateLimiter";
import { ReputationAdmin } from "./pages/admin/Reputation";

// Settings
import { Settings } from "./pages/Settings";

export function App() {
  return (
    <SettingsProvider>
      <WalletProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              {/* Explorer */}
              <Route path="/" element={<Overview />} />
              <Route path="/campaigns" element={<Campaigns />} />
              <Route path="/campaigns/:id" element={<CampaignDetail />} />
              <Route path="/publishers" element={<Publishers />} />
              <Route path="/how-it-works" element={<HowItWorks />} />

              {/* Advertiser */}
              <Route path="/advertiser" element={<AdvertiserDashboard />} />
              <Route path="/advertiser/create" element={<CreateCampaign />} />
              <Route path="/advertiser/campaign/:id" element={<AdvertiserCampaignDetail />} />
              <Route path="/advertiser/campaign/:id/metadata" element={<SetMetadata />} />
              <Route path="/advertiser/analytics" element={<CampaignAnalytics />} />

              {/* Publisher */}
              <Route path="/publisher" element={<PublisherDashboard />} />
              <Route path="/publisher/register" element={<Register />} />
              <Route path="/publisher/rate" element={<TakeRate />} />
              <Route path="/publisher/categories" element={<Categories />} />
              <Route path="/publisher/allowlist" element={<Allowlist />} />
              <Route path="/publisher/earnings" element={<Earnings />} />
              <Route path="/publisher/sdk" element={<SDKSetup />} />
              <Route path="/publisher/profile" element={<PublisherProfile />} />

              {/* Governance */}
              <Route path="/governance" element={<GovernanceDashboard />} />
              <Route path="/governance/vote/:id" element={<Vote />} />
              <Route path="/governance/my-votes" element={<MyVotes />} />
              <Route path="/governance/parameters" element={<GovernanceParameters />} />

              {/* Admin — hidden from nav, accessible via direct URL */}
              <Route path="/admin" element={<Navigate to="/admin/timelock" replace />} />
              <Route path="/admin/timelock" element={<TimelockAdmin />} />
              <Route path="/admin/pause" element={<PauseRegistryAdmin />} />
              <Route path="/admin/blocklist" element={<BlocklistAdmin />} />
              <Route path="/admin/protocol" element={<ProtocolFeesAdmin />} />
              <Route path="/admin/rate-limiter" element={<RateLimiterAdmin />} />
              <Route path="/admin/reputation" element={<ReputationAdmin />} />

              {/* Settings */}
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </WalletProvider>
    </SettingsProvider>
  );
}
