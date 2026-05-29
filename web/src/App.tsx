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
import { AdvertiserProfile as AdvertiserProfileExplorer } from "./pages/explorer/AdvertiserProfile";
import { HowItWorks } from "./pages/explorer/HowItWorks";
import { Philosophy } from "./pages/explorer/Philosophy";

// Advertiser
import { AdvertiserDashboard } from "./pages/advertiser/Dashboard";
import { CreateCampaign } from "./pages/advertiser/CreateCampaign";
import { AdvertiserCampaignDetail } from "./pages/advertiser/CampaignDetail";
import { SetMetadata } from "./pages/advertiser/SetMetadata";
import { CampaignAnalytics } from "./pages/advertiser/Analytics";
import { BulletinManager } from "./pages/advertiser/BulletinManager";
import { AdvertiserCosign } from "./pages/advertiser/Cosign";
import { AdvertiserProfile } from "./pages/advertiser/Profile";

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
import { ActivationBonds as GovernanceActivationBonds } from "./pages/governance/ActivationBonds";
import { Vote } from "./pages/governance/Vote";
import { MyVotes } from "./pages/governance/MyVotes";
import { GovernanceParameters } from "./pages/governance/Parameters";
import { PublisherFraud } from "./pages/governance/PublisherFraud";
import { ProtocolParams } from "./pages/governance/ProtocolParams";
import { Council } from "./pages/governance/Council";
import { AdvertiserFraudClaimsPage } from "./pages/governance/AdvertiserFraudClaims";
import { AdvertiserFraud } from "./pages/governance/AdvertiserFraud";
import { PhaseLadder } from "./pages/governance/PhaseLadder";

// Protocol (template dashboard + new sub-pages)
import { ProtocolDashboard } from "./pages/protocol/Dashboard";
import { TagCurator } from "./pages/protocol/TagCurator";
import { ProtocolBrandCurator } from "./pages/protocol/BrandCurator";
import { Upgrades } from "./pages/protocol/Upgrades";

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
import { RelayAdmin } from "./pages/admin/Relay";
import { Wrapper as WrapperPage } from "./pages/token/Wrapper";
import { FeeShare as FeeSharePage } from "./pages/token/FeeShare";
import { Bootstrap as BootstrapPage } from "./pages/token/Bootstrap";
import { Vesting as VestingPage } from "./pages/token/Vesting";
import { TokenDashboard } from "./pages/token/Dashboard";
import { MintCoordinatorPage } from "./pages/token/MintCoordinator";

// Identity
import { IdentityDashboard } from "./pages/identity/Dashboard";
import { PeopleChain } from "./pages/identity/PeopleChain";
import { IdentityZk } from "./pages/identity/Zk";

// Settings
import { Settings } from "./pages/Settings";
import { HouseAdPreview } from "./pages/settings/HouseAdPreview";

// Me
import { History } from "./pages/me/History";
import { AssurancePage } from "./pages/me/Assurance";
import { IdentityPage } from "./pages/me/Identity";
import { Dust } from "./pages/me/Dust";
import { MeDashboard } from "./pages/me/Dashboard";
import { Branding } from "./pages/me/Branding";

// Demo
import { Demo } from "./pages/Demo";

// About — persona deep dives
import { AboutIndex } from "./pages/about/Index";
import { AboutMe } from "./pages/about/Me";
import { AboutAdvertiser } from "./pages/about/Advertiser";
import { AboutPublisher } from "./pages/about/Publisher";
import { AboutToken } from "./pages/about/Token";
import { AboutRewards } from "./pages/about/Rewards";
import { AboutProtocol } from "./pages/about/Protocol";
import { AboutGovernance } from "./pages/about/Governance";
import { AboutIdentity } from "./pages/about/Identity";
import { AboutEconomics } from "./pages/about/Economics";

export function App() {
  return (
    <SettingsProvider>
      <WalletProvider>
        <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              {/* Explorer — flat paths and /explorer/* aliases per design doc §2.3 */}
              <Route path="/" element={<Overview />} />
              <Route path="/explorer" element={<Overview />} />
              <Route path="/campaigns" element={<Campaigns />} />
              <Route path="/explorer/campaigns" element={<Campaigns />} />
              <Route path="/campaigns/:id" element={<CampaignDetail />} />
              <Route path="/explorer/campaigns/:id" element={<CampaignDetail />} />
              <Route path="/publishers" element={<Publishers />} />
              <Route path="/explorer/publishers" element={<Publishers />} />
              <Route path="/publishers/:address" element={<PublisherProfileExplorer />} />
              <Route path="/explorer/publishers/:address" element={<PublisherProfileExplorer />} />
              <Route path="/advertisers/:address" element={<AdvertiserProfileExplorer />} />
              <Route path="/explorer/advertisers/:address" element={<AdvertiserProfileExplorer />} />
              <Route path="/how-it-works" element={<HowItWorks />} />
              <Route path="/explorer/how-it-works" element={<HowItWorks />} />
              <Route path="/philosophy" element={<Philosophy />} />
              <Route path="/explorer/philosophy" element={<Philosophy />} />

              {/* Advertiser */}
              <Route path="/advertiser" element={<AdvertiserDashboard />} />
              <Route path="/advertiser/profile" element={<AdvertiserProfile />} />
              <Route path="/advertiser/create" element={<CreateCampaign />} />
              <Route path="/advertiser/campaign/:id" element={<AdvertiserCampaignDetail />} />
              <Route path="/advertiser/campaign/:id/metadata" element={<SetMetadata />} />
              <Route path="/advertiser/campaign/:id/bulletin" element={<BulletinManager />} />
              <Route path="/advertiser/analytics" element={<CampaignAnalytics />} />
              <Route path="/advertiser/cosign" element={<AdvertiserCosign />} />

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
              <Route path="/governance/activation-bonds" element={<GovernanceActivationBonds />} />
              <Route path="/governance/vote/:id" element={<Vote />} />
              <Route path="/governance/my-votes" element={<MyVotes />} />
              <Route path="/governance/parameters" element={<GovernanceParameters />} />
              <Route path="/governance/publisher-fraud" element={<PublisherFraud />} />
              <Route path="/governance/protocol" element={<ProtocolParams />} />
              <Route path="/governance/council" element={<Council />} />
              <Route path="/governance/fraud-claims" element={<AdvertiserFraudClaimsPage />} />
              <Route path="/governance/advertiser-fraud" element={<AdvertiserFraud />} />
              <Route path="/governance/phase-ladder" element={<PhaseLadder />} />
              {/* W-LEG-3: /governance/phase was the original path; canonical is now /phase-ladder. */}
              <Route path="/governance/phase" element={<Navigate to="/governance/phase-ladder" replace />} />

              {/* Protocol — template dashboard + per-contract sub-pages.
                  /admin/* paths kept as aliases for back-compat with
                  bookmarks; new design-doc paths point at /protocol/*. */}
              <Route path="/protocol" element={<ProtocolDashboard />} />
              <Route path="/protocol/tag-curator" element={<TagCurator />} />
              <Route path="/protocol/brand-curator" element={<ProtocolBrandCurator />} />
              <Route path="/protocol/upgrades" element={<Upgrades />} />
              <Route path="/protocol/timelock" element={<TimelockAdmin />} />
              <Route path="/protocol/pause-registry" element={<PauseRegistryAdmin />} />
              <Route path="/protocol/blocklist" element={<BlocklistAdmin />} />
              <Route path="/protocol/protocol-fees" element={<ProtocolFeesAdmin />} />
              <Route path="/protocol/parameter-governance" element={<ParameterGovernanceAdmin />} />
              <Route path="/protocol/publisher-stake" element={<PublisherStakeAdmin />} />
              <Route path="/protocol/challenge-bonds" element={<ChallengeBondsAdmin />} />
              <Route path="/protocol/sybil-defense" element={<SybilDefenseAdmin />} />
              <Route path="/protocol/mint-authority" element={<MintAuthorityAdmin />} />
              <Route path="/protocol/relay" element={<RelayAdmin />} />
              <Route path="/admin/relay" element={<Navigate to="/protocol/relay" replace />} />
              {/* Pages that previously only existed at /admin/*. Promoted
                  to /protocol/* so the canonical path is consistent
                  across the section (per PROCESS-FLOW-AUDIT W-LEG-1). */}
              <Route path="/protocol/rate-limiter" element={<RateLimiterAdmin />} />
              <Route path="/protocol/reputation" element={<ReputationAdmin />} />
              <Route path="/protocol/publisher-governance" element={<PublisherGovernanceAdmin />} />
              <Route path="/protocol/nullifier-registry" element={<NullifierRegistryAdmin />} />

              {/* /admin/* — back-compat redirects for stale bookmarks.
                  Per W-LEG-1: no in-app navigation points here. */}
              <Route path="/admin" element={<Navigate to="/protocol/timelock" replace />} />
              <Route path="/admin/timelock" element={<Navigate to="/protocol/timelock" replace />} />
              <Route path="/admin/pause" element={<Navigate to="/protocol/pause-registry" replace />} />
              <Route path="/admin/blocklist" element={<Navigate to="/protocol/blocklist" replace />} />
              <Route path="/admin/protocol" element={<Navigate to="/protocol/protocol-fees" replace />} />
              <Route path="/admin/rate-limiter" element={<Navigate to="/protocol/rate-limiter" replace />} />
              <Route path="/admin/reputation" element={<Navigate to="/protocol/reputation" replace />} />
              <Route path="/admin/parameter-governance" element={<Navigate to="/protocol/parameter-governance" replace />} />
              <Route path="/admin/publisher-stake" element={<Navigate to="/protocol/publisher-stake" replace />} />
              <Route path="/admin/publisher-governance" element={<Navigate to="/protocol/publisher-governance" replace />} />
              <Route path="/admin/challenge-bonds" element={<Navigate to="/protocol/challenge-bonds" replace />} />
              <Route path="/admin/nullifier-registry" element={<Navigate to="/protocol/nullifier-registry" replace />} />
              <Route path="/admin/sybil-defense" element={<Navigate to="/protocol/sybil-defense" replace />} />
              <Route path="/admin/mint-authority" element={<Navigate to="/protocol/mint-authority" replace />} />

              {/* DATUM token system */}
              <Route path="/token" element={<TokenDashboard />} />
              <Route path="/token/wrapper" element={<WrapperPage />} />
              <Route path="/token/fee-share" element={<FeeSharePage />} />
              <Route path="/token/bootstrap" element={<BootstrapPage />} />
              <Route path="/token/vesting" element={<VestingPage />} />
              <Route path="/token/mint-coordinator" element={<MintCoordinatorPage />} />

              {/* Identity */}
              <Route path="/identity" element={<IdentityDashboard />} />
              <Route path="/identity/people-chain" element={<PeopleChain />} />
              <Route path="/identity/zk" element={<IdentityZk />} />

              {/* Settings */}
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/house-ads" element={<HouseAdPreview />} />

              {/* Me — wallet-scoped views */}
              <Route path="/me" element={<MeDashboard />} />
              <Route path="/me/history" element={<History />} />
              <Route path="/me/assurance" element={<AssurancePage />} />
              <Route path="/me/identity" element={<IdentityPage />} />
              <Route path="/me/dust" element={<Dust />} />
              <Route path="/me/branding" element={<Branding />} />

              {/* About — persona deep dives */}
              <Route path="/about" element={<AboutIndex />} />
              <Route path="/about/me" element={<AboutMe />} />
              <Route path="/about/advertiser" element={<AboutAdvertiser />} />
              <Route path="/about/publisher" element={<AboutPublisher />} />
              <Route path="/about/token" element={<AboutToken />} />
              <Route path="/about/rewards" element={<AboutRewards />} />
              <Route path="/about/protocol" element={<AboutProtocol />} />
              <Route path="/about/governance" element={<AboutGovernance />} />
              <Route path="/about/identity" element={<AboutIdentity />} />
              <Route path="/about/economics" element={<AboutEconomics />} />

              {/* Demo */}
              <Route path="/demo" element={<Demo />} />

              {/* Catch-all: any unknown path renders the Overview rather
                  than a blank page. SPA visitors who land on a stale
                  bookmark, share link, or typo see the explorer instead
                  of nothing. */}
              <Route path="*" element={<Overview />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <ToastContainer />
        </ToastProvider>
      </WalletProvider>
    </SettingsProvider>
  );
}
