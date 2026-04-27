<?php
/**
 * [datum_slot] shortcode.
 *
 * Usage:
 *   [datum_slot format="leaderboard"]
 *   [datum_slot format="medium-rectangle" class="my-ad"]
 *
 * @package DatumPublisher
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Class Datum_Shortcode
 */
class Datum_Shortcode {

	/** Valid IAB slot format values */
	const VALID_FORMATS = array(
		'medium-rectangle',
		'leaderboard',
		'wide-skyscraper',
		'half-page',
		'mobile-banner',
		'square',
		'large-rectangle',
	);

	public function __construct() {
		add_shortcode( 'datum_slot', array( $this, 'render' ) );
	}

	/**
	 * Render the shortcode output.
	 *
	 * @param array $atts Shortcode attributes.
	 * @return string HTML output.
	 */
	public function render( $atts ) {
		$settings = datum_publisher_get_settings();
		if ( empty( $settings['publisher'] ) ) {
			return '';
		}

		$atts = shortcode_atts(
			array(
				'format' => 'medium-rectangle',
				'class'  => '',
			),
			$atts,
			'datum_slot'
		);

		$format = sanitize_text_field( $atts['format'] );
		if ( ! in_array( $format, self::VALID_FORMATS, true ) ) {
			$format = 'medium-rectangle';
		}

		$class = 'datum-ad-slot';
		if ( ! empty( $atts['class'] ) ) {
			$class .= ' ' . sanitize_html_class( $atts['class'] );
		}

		return sprintf(
			'<div class="%s" data-datum-slot="%s"></div>',
			esc_attr( $class ),
			esc_attr( $format )
		);
	}
}

new Datum_Shortcode();
