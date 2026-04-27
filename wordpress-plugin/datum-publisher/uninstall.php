<?php
/**
 * Uninstall routine — runs when the plugin is deleted from WP admin.
 * Removes all stored plugin options.
 *
 * @package DatumPublisher
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'datum_publisher_settings' );
