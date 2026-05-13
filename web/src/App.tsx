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
import { PublisherProfile as PublisherProfileExplorer } from "./pages/explorer/PublisherProfile";
import { AdvertiserProfile } from "./pages/explorer/AdvertiserProfile";
import { HowItWorks } from "./pages/explorer/HowItWorks";
import { Philosophy } from "./pages/explorer/Philosophy";

// Advertiser
import { AdvertiserDashboard } from "./pages/advertiser/Dashboard";
import { CreateCampaign } from "./pages/advertiser/CreateCampaign";
import { AdvertiserCampaignDetail } from "./pages/advertiser/CampaignDetail";
import { SetMetadata } from "./pages/advertiser/SetMetadata";
import { CampaignAnalytics } from "./pages/advertiser/Analytics";
import { BulletinManager } from "./pages/advertiser/BulletinManager";

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
import { PublisherFraud } from "./pages/governance/PublisherFraud";
import { ProtocolParams } from "./pages/governance/ProtocolParams";
import { Council } from "./pages/governance/Council";
import { AdvertiserFraudClaimsPage } from "./pages/governance/AdvertiserFraudClaims";
import { PhaseLadder } from "./pages/governance/PhaseLadder";

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
import { SybilDefenseAdmin } from "./pages/admin/SybilDefense";
import { MintAuthorityAdmin } from "./pages/admin/MintAuthority";
import { Wrapper as WrapperPage } from "./pages/token/Wrapper";
import { FeeShare as FeeSharePage } from "./pages/token/FeeShare";
import { Bootstrap as BootstrapPage } from "./pages/token/Bootstrap";
import { Vesting as VestingPage } from "./pages/token/Vesting";

// Settings
import { Settings } from "./pages/Settings";
import { HouseAdPreview } from "./pages/settings/HouseAdPreview";

// Me
import { History } from "./pages/me/History";
import { AssurancePage } from "./pages/me/Assurance";
import { Dust } from "./pages/me/Dust";

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
              <Route path="/publishers/:address" element={<PublisherProfileExplorer />} />
              <Route path="/advertisers/:address" element={<AdvertiserProfile />} />
              <Route path="/how-it-works" element={<HowItWorks />} />
              <Route path="/philosophy" element={<Philosophy />} />

              {/* Advertiser */}
              <Route path="/advertiser" element={<AdvertiserDashboard />} />
              <Route path="/advertiser/create" element={<CreateCampaign />} />
              <Route path="/advertiser/campaign/:id" element={<AdvertiserCampaignDetail />} />
              <Route path="/advertiser/campaign/:id/metadata" element={<SetMetadata />} />
              <Route path="/advertiser/campaign/:id/bulletin" element={<BulletinManager />} />
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
              <Route path="/governance/publisher-fraud" element={<PublisherFraud />} />
              <Route path="/governance/protocol" element={<ProtocolParams />} />
              <Route path="/governance/council" element={<Council />} />
              <Route path="/governance/fraud-claims" element={<AdvertiserFraudClaimsPage />} />
              <Route path="/governance/phase" element={<PhaseLadder />} />

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
              <Route path="/admin/sybil-defense" element={<SybilDefenseAdmin />} />
              <Route path="/admin/mint-authority" element={<MintAuthorityAdmin />} />

              {/* DATUM token system */}
              <Route path="/token" element={<Navigate to="/token/wrapper" replace />} />
              <Route path="/token/wrapper" element={<WrapperPage />} />
              <Route path="/token/fee-share" element={<FeeSharePage />} />
              <Route path="/token/bootstrap" element={<BootstrapPage />} />
              <Route path="/token/vesting" element={<VestingPage />} />

              {/* Settings */}
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/house-ads" element={<HouseAdPreview />} />

              {/* Me — wallet-scoped views */}
              <Route path="/me/history" element={<History />} />
              <Route path="/me/assurance" element={<AssurancePage />} />
              <Route path="/me/dust" element={<Dust />} />

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
