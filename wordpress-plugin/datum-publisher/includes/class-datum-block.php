<?php
/**
 * Gutenberg block: datum-publisher/ad-slot.
 *
 * @package DatumPublisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class Datum_Block
 */
class Datum_Block {

	public function __construct() {
		add_action( 'init', array( $this, 'register_block' ) );
	}

	/**
	 * Register the block type and its editor assets.
	 */
	public function register_block() {
		wp_register_script(
			'datum-block-editor',
			DATUM_PUBLISHER_URL . 'assets/js/block-editor.js',
			array( 'wp-blocks', 'wp-block-editor', 'wp-components', 'wp-element', 'wp-i18n' ),
			DATUM_PUBLISHER_VERSION,
			false
		);

		wp_register_style(
			'datum-block-editor-style',
			DATUM_PUBLISHER_URL . 'assets/css/admin.css',
			array(),
			DATUM_PUBLISHER_VERSION
		);

		register_block_type(
			'datum-publisher/ad-slot',
			array(
				'editor_script'   => 'datum-block-editor',
				'editor_style'    => 'datum-block-editor-style',
				'render_callback' => array( $this, 'render_block' ),
				'attributes'      => array(
					'format' => array(
						'type'    => 'string',
						'default' => 'medium-rectangle',
					),
				),
			)
		);
	}

	/**
	 * Server-side render callback for the block.
	 *
	 * @param array $attributes Block attributes.
	 * @return string HTML output.
	 */
	public function render_block( $attributes ) {
		$settings = datum_publisher_get_settings();
		if ( empty( $settings['publisher'] ) ) {
			return '';
		}

		$valid_formats = array(
			'medium-rectangle',
			'leaderboard',
			'wide-skyscraper',
			'half-page',
			'mobile-banner',
			'square',
			'large-rectangle',
		);

		$format = sanitize_text_field( $attributes['format'] ?? 'medium-rectangle' );
		if ( ! in_array( $format, $valid_formats, true ) ) {
			$format = 'medium-rectangle';
		}

		return sprintf(
			'<div class="datum-ad-slot" data-datum-slot="%s"></div>',
			esc_attr( $format )
		);
	}
}

new Datum_Block();
