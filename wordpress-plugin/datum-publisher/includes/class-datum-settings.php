<?php
/**
 * Admin settings page for DATUM Publisher.
 *
 * @package DatumPublisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class Datum_Settings
 *
 * Registers the Settings > DATUM Publisher admin page and all option fields.
 */
class Datum_Settings {

	/** @var string Option group name */
	const OPTION_GROUP = 'datum_publisher';

	/** @var string Option name in wp_options */
	const OPTION_NAME = DATUM_PUBLISHER_OPTION;

	/** @var string Menu slug */
	const MENU_SLUG = 'datum-publisher';

	public function __construct() {
		add_action( 'admin_menu', array( $this, 'add_page' ) );
		add_action( 'admin_init', array( $this, 'register_settings' ) );
		add_action( 'admin_enqueue_scripts', array( $this, 'enqueue_admin_assets' ) );
	}

	/**
	 * Add the settings page under Settings menu.
	 */
	public function add_page() {
		add_options_page(
			__( 'DATUM Publisher', 'datum-publisher' ),
			__( 'DATUM Publisher', 'datum-publisher' ),
			'manage_options',
			self::MENU_SLUG,
			array( $this, 'render_page' )
		);
	}

	/**
	 * Enqueue admin stylesheet on the plugin settings page.
	 *
	 * @param string $hook Current admin page hook.
	 */
	public function enqueue_admin_assets( $hook ) {
		if ( 'settings_page_datum-publisher' !== $hook ) {
			return;
		}
		wp_enqueue_style(
			'datum-publisher-admin',
			DATUM_PUBLISHER_URL . 'assets/css/admin.css',
			array(),
			DATUM_PUBLISHER_VERSION
		);
	}

	/**
	 * Register settings, sections, and fields via the Settings API.
	 */
	public function register_settings() {
		register_setting(
			self::OPTION_GROUP,
			self::OPTION_NAME,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( $this, 'sanitize_settings' ),
				'default'           => array(),
			)
		);

		// Section: Publisher Identity
		add_settings_section(
			'datum_identity',
			__( 'Publisher Identity', 'datum-publisher' ),
			array( $this, 'render_identity_section' ),
			self::MENU_SLUG
		);

		add_settings_field(
			'publisher',
			__( 'Publisher Wallet Address', 'datum-publisher' ),
			array( $this, 'render_publisher_field' ),
			self::MENU_SLUG,
			'datum_identity'
		);

		add_settings_field(
			'relay',
			__( 'Relay URL', 'datum-publisher' ),
			array( $this, 'render_relay_field' ),
			self::MENU_SLUG,
			'datum_identity'
		);

		// Section: Targeting
		add_settings_section(
			'datum_targeting',
			__( 'Targeting', 'datum-publisher' ),
			array( $this, 'render_targeting_section' ),
			self::MENU_SLUG
		);

		add_settings_field(
			'tags',
			__( 'Page Tags', 'datum-publisher' ),
			array( $this, 'render_tags_field' ),
			self::MENU_SLUG,
			'datum_targeting'
		);

		add_settings_field(
			'excluded_tags',
			__( 'Excluded Tags', 'datum-publisher' ),
			array( $this, 'render_excluded_tags_field' ),
			self::MENU_SLUG,
			'datum_targeting'
		);
	}

	/**
	 * Sanitize all settings on save.
	 *
	 * @param array $input Raw input.
	 * @return array
	 */
	public function sanitize_settings( $input ) {
		$clean = array();

		$clean['publisher'] = isset( $input['publisher'] )
			? sanitize_text_field( $input['publisher'] )
			: '';

		$clean['relay'] = isset( $input['relay'] )
			? esc_url_raw( $input['relay'] )
			: '';

		$clean['tags'] = isset( $input['tags'] )
			? sanitize_text_field( $input['tags'] )
			: '';

		$clean['excluded_tags'] = isset( $input['excluded_tags'] )
			? sanitize_text_field( $input['excluded_tags'] )
			: '';

		return $clean;
	}

	// -------------------------------------------------------------------------
	// Section descriptions
	// -------------------------------------------------------------------------

	public function render_identity_section() {
		echo '<p>' . esc_html__( 'Your publisher wallet address is required. It identifies you on-chain so ad revenue is attributed and paid to you in DOT.', 'datum-publisher' ) . '</p>';
	}

	public function render_targeting_section() {
		echo '<p>' . esc_html__( 'Tags describe your site\'s content so advertisers can target relevant campaigns to your audience. Use comma-separated dimension:value strings (e.g. topic:defi,locale:en).', 'datum-publisher' ) . '</p>';
	}

	// -------------------------------------------------------------------------
	// Field renderers
	// -------------------------------------------------------------------------

	public function render_publisher_field() {
		$settings  = datum_publisher_get_settings();
		$publisher = esc_attr( $settings['publisher'] );
		?>
		<input
			type="text"
			id="datum_publisher"
			name="<?php echo esc_attr( self::OPTION_NAME ); ?>[publisher]"
			value="<?php echo $publisher; ?>"
			class="regular-text datum-mono"
			placeholder="0x…"
			spellcheck="false"
		/>
		<p class="description">
			<?php esc_html_e( 'Your Ethereum-compatible wallet address (0x…). Must be registered on the DATUM Publishers contract.', 'datum-publisher' ); ?>
		</p>
		<?php
	}

	public function render_relay_field() {
		$settings = datum_publisher_get_settings();
		$relay    = esc_attr( $settings['relay'] );
		?>
		<input
			type="url"
			id="datum_relay"
			name="<?php echo esc_attr( self::OPTION_NAME ); ?>[relay]"
			value="<?php echo $relay; ?>"
			class="regular-text"
			placeholder="https://relay.example.com"
		/>
		<p class="description">
			<?php esc_html_e( 'Optional. Your publisher relay endpoint. Leave blank to use the default DATUM relay.', 'datum-publisher' ); ?>
		</p>
		<?php
	}

	public function render_tags_field() {
		$settings = datum_publisher_get_settings();
		$tags     = esc_attr( $settings['tags'] );
		?>
		<input
			type="text"
			id="datum_tags"
			name="<?php echo esc_attr( self::OPTION_NAME ); ?>[tags]"
			value="<?php echo $tags; ?>"
			class="large-text"
			placeholder="topic:defi,locale:en,audience:developer"
		/>
		<p class="description">
			<?php esc_html_e( 'Comma-separated tags describing your site (e.g. topic:crypto-web3, locale:en). Advertisers filter by these.', 'datum-publisher' ); ?>
		</p>
		<?php
	}

	public function render_excluded_tags_field() {
		$settings = datum_publisher_get_settings();
		$excluded = esc_attr( $settings['excluded_tags'] );
		?>
		<input
			type="text"
			id="datum_excluded_tags"
			name="<?php echo esc_attr( self::OPTION_NAME ); ?>[excluded_tags]"
			value="<?php echo $excluded; ?>"
			class="large-text"
			placeholder="topic:gambling,topic:adult"
		/>
		<p class="description">
			<?php esc_html_e( 'Comma-separated tags for categories you do not want shown. Campaigns requiring these tags will be blocked.', 'datum-publisher' ); ?>
		</p>
		<?php
	}

	// -------------------------------------------------------------------------
	// Page render
	// -------------------------------------------------------------------------

	public function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = datum_publisher_get_settings();
		?>
		<div class="wrap datum-settings-wrap">
			<h1 class="datum-settings-title">
				<span class="datum-logo">⬡</span>
				<?php esc_html_e( 'DATUM Publisher', 'datum-publisher' ); ?>
			</h1>

			<?php if ( ! empty( $settings['publisher'] ) ) : ?>
				<div class="datum-status datum-status--active">
					<strong><?php esc_html_e( 'Active', 'datum-publisher' ); ?></strong>
					<?php
					printf(
						/* translators: %s: wallet address */
						esc_html__( '— serving ads for %s', 'datum-publisher' ),
						'<code>' . esc_html( $settings['publisher'] ) . '</code>'
					);
					?>
				</div>
			<?php else : ?>
				<div class="datum-status datum-status--inactive">
					<?php esc_html_e( 'Not configured — enter your publisher address below.', 'datum-publisher' ); ?>
				</div>
			<?php endif; ?>

			<form method="post" action="options.php">
				<?php
				settings_fields( self::OPTION_GROUP );
				do_settings_sections( self::MENU_SLUG );
				submit_button( __( 'Save Settings', 'datum-publisher' ) );
				?>
			</form>

			<hr />

			<div class="datum-usage">
				<h2><?php esc_html_e( 'How to place ad slots', 'datum-publisher' ); ?></h2>

				<h3><?php esc_html_e( 'Shortcode', 'datum-publisher' ); ?></h3>
				<p><?php esc_html_e( 'Paste into any post, page, or text widget:', 'datum-publisher' ); ?></p>
				<pre><code>[datum_slot format="medium-rectangle"]
[datum_slot format="leaderboard"]</code></pre>

				<h3><?php esc_html_e( 'Block Editor', 'datum-publisher' ); ?></h3>
				<p><?php esc_html_e( 'Search for "DATUM Ad Slot" in the block inserter and drag it anywhere on your page.', 'datum-publisher' ); ?></p>

				<h3><?php esc_html_e( 'Widget', 'datum-publisher' ); ?></h3>
				<p>
					<?php
					printf(
						/* translators: %s: widgets admin URL */
						esc_html__( 'Add the "DATUM Ad Slot" widget in %s.', 'datum-publisher' ),
						'<a href="' . esc_url( admin_url( 'widgets.php' ) ) . '">' . esc_html__( 'Appearance → Widgets', 'datum-publisher' ) . '</a>'
					);
					?>
				</p>

				<h3><?php esc_html_e( 'Available formats', 'datum-publisher' ); ?></h3>
				<table class="datum-formats-table widefat striped">
					<thead>
						<tr>
							<th><?php esc_html_e( 'Format value', 'datum-publisher' ); ?></th>
							<th><?php esc_html_e( 'Dimensions', 'datum-publisher' ); ?></th>
						</tr>
					</thead>
					<tbody>
						<tr><td><code>medium-rectangle</code></td><td>300 × 250</td></tr>
						<tr><td><code>leaderboard</code></td><td>728 × 90</td></tr>
						<tr><td><code>wide-skyscraper</code></td><td>160 × 600</td></tr>
						<tr><td><code>half-page</code></td><td>300 × 600</td></tr>
						<tr><td><code>mobile-banner</code></td><td>320 × 50</td></tr>
						<tr><td><code>square</code></td><td>250 × 250</td></tr>
						<tr><td><code>large-rectangle</code></td><td>336 × 280</td></tr>
					</tbody>
				</table>
			</div>
		</div>
		<?php
	}
}

new Datum_Settings();
