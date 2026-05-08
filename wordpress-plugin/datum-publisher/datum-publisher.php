<?php
/**
 * Plugin Name:       DATUM Publisher
 * Plugin URI:        https://github.com/Baronvonbonbon/datum
 * Description:       Embed the DATUM Publisher SDK on your WordPress site. Place ad slots via shortcode, block, or widget and earn DOT for verified impressions.
 * Version:           1.0.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            DATUM Network
 * Author URI:        https://datum.javcon.io
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       datum-publisher
 * Domain Path:       /languages
 *
 * @package DatumPublisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'DATUM_PUBLISHER_VERSION', '1.0.0' );
define( 'DATUM_PUBLISHER_FILE', __FILE__ );
define( 'DATUM_PUBLISHER_DIR', plugin_dir_path( __FILE__ ) );
define( 'DATUM_PUBLISHER_URL', plugin_dir_url( __FILE__ ) );
define( 'DATUM_PUBLISHER_OPTION', 'datum_publisher_settings' );

require_once DATUM_PUBLISHER_DIR . 'includes/class-datum-settings.php';
require_once DATUM_PUBLISHER_DIR . 'includes/class-datum-shortcode.php';
require_once DATUM_PUBLISHER_DIR . 'includes/class-datum-widget.php';
require_once DATUM_PUBLISHER_DIR . 'includes/class-datum-block.php';

/**
 * Retrieve plugin settings with defaults.
 *
 * @return array
 */
function datum_publisher_get_settings() {
	$defaults = array(
		'publisher'     => '',
		'tags'          => '',
		'excluded_tags' => '',
		'relay'         => '',
	);
	return wp_parse_args( get_option( DATUM_PUBLISHER_OPTION, array() ), $defaults );
}

/**
 * Enqueue datum-sdk.js on the front end when a publisher address is configured.
 * Data attributes are injected via the script_loader_tag filter so the SDK can
 * read them from document.currentScript.
 */
function datum_publisher_enqueue_scripts() {
	$settings = datum_publisher_get_settings();
	if ( empty( $settings['publisher'] ) ) {
		return;
	}

	wp_enqueue_script(
		'datum-sdk',
		DATUM_PUBLISHER_URL . 'assets/js/datum-sdk.js',
		array(),
		DATUM_PUBLISHER_VERSION,
		true // footer
	);
}
add_action( 'wp_enqueue_scripts', 'datum_publisher_enqueue_scripts' );

/**
 * Inject data-* attributes onto the datum-sdk script tag.
 *
 * @param string $tag    The script tag HTML.
 * @param string $handle The script handle.
 * @return string
 */
function datum_publisher_script_loader_tag( $tag, $handle ) {
	if ( 'datum-sdk' !== $handle ) {
		return $tag;
	}

	$settings  = datum_publisher_get_settings();
	$publisher = esc_attr( $settings['publisher'] );
	$tags      = esc_attr( $settings['tags'] );
	$excluded  = esc_attr( $settings['excluded_tags'] );
	$relay     = esc_attr( $settings['relay'] );

	$attrs = ' data-publisher="' . $publisher . '"';
	if ( $tags ) {
		$attrs .= ' data-tags="' . $tags . '"';
	}
	if ( $excluded ) {
		$attrs .= ' data-excluded-tags="' . $excluded . '"';
	}
	if ( $relay ) {
		$attrs .= ' data-relay="' . $relay . '"';
	}

	// Insert data attributes before the src attribute.
	return str_replace( ' src=', $attrs . ' src=', $tag );
}
add_filter( 'script_loader_tag', 'datum_publisher_script_loader_tag', 10, 2 );

/**
 * Load plugin textdomain.
 */
function datum_publisher_load_textdomain() {
	load_plugin_textdomain( 'datum-publisher', false, dirname( plugin_basename( __FILE__ ) ) . '/languages' );
}
add_action( 'plugins_loaded', 'datum_publisher_load_textdomain' );

/**
 * Show admin notice when publisher address is not configured.
 */
function datum_publisher_admin_notice() {
	$settings = datum_publisher_get_settings();
	if ( ! empty( $settings['publisher'] ) ) {
		return;
	}
	$url = admin_url( 'options-general.php?page=datum-publisher' );
	printf(
		'<div class="notice notice-warning is-dismissible"><p>%s <a href="%s">%s</a></p></div>',
		esc_html__( 'DATUM Publisher: enter your publisher wallet address to start serving ads.', 'datum-publisher' ),
		esc_url( $url ),
		esc_html__( 'Configure now', 'datum-publisher' )
	);
}
add_action( 'admin_notices', 'datum_publisher_admin_notice' );
