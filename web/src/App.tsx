import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { SettingsProvider } from "./context/SettingsContext";
import { WalletProvider } from "./context/WalletContext";
import { ToastProvider } from "./context/ToastContext";
import { ToastContainer } from "./components/ToastContainer";
import { Layout } from "./components/Layout";

// Explorer
import { Overview } from "./pages/explorer/Overview";
import { Campaigns } from "./pages/explorer/Campaigns";
import { CampaignDetail } from "./pages/explorer/CampaignDetail";
import { Publishers } from "./pages/explorer/Publishers";
import { PublisherProfile } from "./pages/explorer/PublisherProfile";
import { AdvertiserProfile } from "./pages/explorer/AdvertiserProfile";
import { HowItWorks } from "./pages/explorer/HowItWorks";
import { Philosophy } from "./pages/explorer/Philosophy";

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
import { PublisherStake } from "./pages/publisher/Stake";

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
import { ParameterGovernanceAdmin } from "./pages/admin/ParameterGovernance";
import { PublisherStakeAdmin } from "./pages/admin/PublisherStake";
import { PublisherGovernanceAdmin } from "./pages/admin/PublisherGovernance";
import { ChallengeBondsAdmin } from "./pages/admin/ChallengeBonds";
import { NullifierRegistryAdmin } from "./pages/admin/NullifierRegistry";

// Settings
import { Settings } from "./pages/Settings";

// Demo
import { Demo } from "./pages/Demo";

export function App() {
  return (
    <SettingsProvider>
      <WalletProvider>
        <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              {/* Explorer */}
              <Route path="/" element={<Overview />} />
              <Route path="/campaigns" element={<Campaigns />} />
              <Route path="/campaigns/:id" element={<CampaignDetail />} />
              <Route path="/publishers" element={<Publishers />} />
              <Route path="/publishers/:address" element={<PublisherProfile />} />
              <Route path="/advertisers/:address" element={<AdvertiserProfile />} />
              <Route path="/how-it-works" element={<HowItWorks />} />
              <Route path="/philosophy" element={<Philosophy />} />

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
              <Route path="/publisher/stake" element={<PublisherStake />} />

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
              <Route path="/admin/parameter-governance" element={<ParameterGovernanceAdmin />} />
              <Route path="/admin/publisher-stake" element={<PublisherStakeAdmin />} />
              <Route path="/admin/publisher-governance" element={<PublisherGovernanceAdmin />} />
              <Route path="/admin/challenge-bonds" element={<ChallengeBondsAdmin />} />
              <Route path="/admin/nullifier-registry" element={<NullifierRegistryAdmin />} />

              {/* Settings */}
              <Route path="/settings" element={<Settings />} />

              {/* Demo */}
              <Route path="/demo" element={<Demo />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <ToastContainer />
        </ToastProvider>
      </WalletProvider>
    </SettingsProvider>
  );
}
